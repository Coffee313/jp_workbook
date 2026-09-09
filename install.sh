#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-jp-workbook}"
PORT="${PORT:-3000}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
DATA_DIR="${DATA_DIR:-/var/lib/jp-workbook}"
SERVER_NAME="${SERVER_NAME:-}"
OPEN_FIREWALL="${OPEN_FIREWALL:-false}"

usage() {
  cat <<'HELP'
Установка Kotoba Room как systemd-сервиса с Nginx и HTTPS.

Запуск:
  sudo ./install.sh [параметры]

Параметры:
  --port N                внутренний PORT Node.js (по умолчанию 3000)
  --bind ADDRESS          BIND_ADDRESS Node.js (по умолчанию 127.0.0.1)
  --server-name NAME      домен или IP для Nginx и сертификата
  --data-dir PATH         каталог постоянных данных
  --open-firewall         открыть 80/443 в активном UFW
  -h, --help              показать справку

Те же параметры можно задать переменными SERVICE_NAME, PORT,
BIND_ADDRESS, SERVER_NAME, DATA_DIR и OPEN_FIREWALL.
Скрипт создаёт самоподписанный HTTPS-сертификат. Браузер покажет
предупреждение, пока сертификат не будет заменён доверенным.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --bind) BIND_ADDRESS="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --open-firewall) OPEN_FIREWALL=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || { echo "Запустите через sudo: sudo ./install.sh" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { echo "Некорректный PORT: $PORT" >&2; exit 2; }
if [[ -z "$SERVER_NAME" ]]; then
  SERVER_NAME="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)"
  [[ -n "$SERVER_NAME" ]] || SERVER_NAME="$(hostname -f 2>/dev/null || hostname)"
  echo "--server-name не задан; используется $SERVER_NAME"
fi
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректное имя сервиса: $SERVICE_NAME" >&2; exit 2; }
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный домен или IP: $SERVER_NAME" >&2; exit 2; }
for value in "$SERVICE_NAME" "$BIND_ADDRESS" "$SERVER_NAME" "$DATA_DIR"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "Недопустимый перевод строки в параметре" >&2; exit 2; }
done

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/server.mjs" && -f "$APP_DIR/public/index.html" ]] || {
  echo "Запускайте install.sh из клонированного репозитория jp_workbook." >&2; exit 1;
}

RUN_USER="${APP_USER:-${SUDO_USER:-}}"
if [[ -z "$RUN_USER" || "$RUN_USER" == root ]]; then
  RUN_USER="$(stat -c '%U' "$APP_DIR")"
fi
[[ "$RUN_USER" != root && -n "$RUN_USER" ]] || {
  echo "Не найден непривилегированный пользователь. Запустите sudo от обычного пользователя или задайте APP_USER." >&2; exit 1;
}
id "$RUN_USER" >/dev/null 2>&1 || { echo "Пользователь $RUN_USER не существует." >&2; exit 1; }
RUN_GROUP="$(id -gn "$RUN_USER")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[[ -n "$RUN_HOME" ]] || { echo "Не найден домашний каталог пользователя $RUN_USER." >&2; exit 1; }

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_PATH="/etc/nginx/sites-available/${SERVICE_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}"
TLS_DIR="/etc/ssl/${SERVICE_NAME}"
CERT_PATH="$TLS_DIR/${SERVICE_NAME}.crt"
KEY_PATH="$TLS_DIR/${SERVICE_NAME}.key"
STAMP="$(date +%Y%m%d%H%M%S)"
UNIT_BACKUP=""
NGINX_BACKUP=""
CERT_BACKUP=""
KEY_BACKUP=""
CERT_CHANGED=false
UNIT_INSTALLED=false
NGINX_INSTALLED=false

rollback() {
  local code=$?
  trap - ERR
  echo "Установка не прошла проверку. Выполняется rollback…" >&2
  if [[ "$CERT_CHANGED" == true ]]; then
    if [[ -n "$CERT_BACKUP" && -f "$CERT_BACKUP" ]]; then cp -a "$CERT_BACKUP" "$CERT_PATH"; else rm -f "$CERT_PATH"; fi
    if [[ -n "$KEY_BACKUP" && -f "$KEY_BACKUP" ]]; then cp -a "$KEY_BACKUP" "$KEY_PATH"; else rm -f "$KEY_PATH"; fi
  fi
  if [[ "$NGINX_INSTALLED" == true ]]; then
    if [[ -n "$NGINX_BACKUP" && -f "$NGINX_BACKUP" ]]; then cp -a "$NGINX_BACKUP" "$NGINX_PATH"; else rm -f "$NGINX_PATH" "$NGINX_LINK"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
  if [[ "$UNIT_INSTALLED" == true ]]; then
    if [[ -n "$UNIT_BACKUP" && -f "$UNIT_BACKUP" ]]; then
      cp -a "$UNIT_BACKUP" "$UNIT_PATH"
      systemctl daemon-reload
      systemctl restart "$SERVICE_NAME" || true
    else
      systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
      rm -f "$UNIT_PATH"
      systemctl daemon-reload
    fi
  fi
  exit "$code"
}
trap rollback ERR

echo "[1/7] Установка системных зависимостей…"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx openssl git

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"; fi
if (( NODE_MAJOR < 22 )); then
  echo "Устанавливается Node.js 22…"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

command -v npm >/dev/null || { echo "npm не установлен" >&2; exit 1; }

echo "[2/7] Установка зависимостей и тестирование…"
runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" bash -c "cd '$APP_DIR' && npm ci && npm test"
runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" bash -c "cd '$APP_DIR' && npm prune --omit=dev"

install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$DATA_DIR"

echo "[3/7] Создание самоподписанного HTTPS-сертификата…"
install -d -m 0750 "$TLS_DIR"
CERT_VALID=false
if [[ -s "$CERT_PATH" && -s "$KEY_PATH" ]]; then
  if [[ "$SERVER_NAME" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    openssl x509 -in "$CERT_PATH" -noout -checkip "$SERVER_NAME" >/dev/null 2>&1 && CERT_VALID=true
  else
    openssl x509 -in "$CERT_PATH" -noout -checkhost "$SERVER_NAME" >/dev/null 2>&1 && CERT_VALID=true
  fi
fi
if [[ "$CERT_VALID" != true ]]; then
  if [[ -f "$CERT_PATH" ]]; then CERT_BACKUP="${CERT_PATH}.backup-${STAMP}"; cp -a "$CERT_PATH" "$CERT_BACKUP"; fi
  if [[ -f "$KEY_PATH" ]]; then KEY_BACKUP="${KEY_PATH}.backup-${STAMP}"; cp -a "$KEY_PATH" "$KEY_BACKUP"; fi
  CERT_CHANGED=true
  CERT_NAME="$SERVER_NAME"
  PUBLIC_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)"
  if [[ "$CERT_NAME" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then SAN="IP:${CERT_NAME}"; else SAN="DNS:${CERT_NAME}"; fi
  [[ -n "$PUBLIC_IP" && "$PUBLIC_IP" != "$CERT_NAME" ]] && SAN="${SAN},IP:${PUBLIC_IP}"
  openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
    -keyout "$KEY_PATH" -out "$CERT_PATH" \
    -subj "/CN=${CERT_NAME}" -addext "subjectAltName=${SAN}"
  chmod 0600 "$KEY_PATH"
  chmod 0644 "$CERT_PATH"
else
  echo "Существующий сертификат подходит для $SERVER_NAME и сохранён: $CERT_PATH"
fi

echo "[4/7] Установка systemd unit…"
if [[ -f "$UNIT_PATH" ]]; then UNIT_BACKUP="${UNIT_PATH}.backup-${STAMP}"; cp -a "$UNIT_PATH" "$UNIT_BACKUP"; fi
UNIT_TMP="$(mktemp)"
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=Kotoba Room Japanese Workbook
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=$BIND_ADDRESS
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$UNIT_TMP" "$UNIT_PATH"
rm -f "$UNIT_TMP"
UNIT_INSTALLED=true
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[5/7] Проверка Node.js-сервиса…"
READY=false
for _ in {1..30}; do
  if curl --silent --fail --max-time 3 "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then READY=true; break; fi
  sleep 1
done
[[ "$READY" == true ]] || { journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true; false; }

echo "[6/7] Настройка Nginx и WebSocket proxy…"
if [[ -f "$NGINX_PATH" ]]; then NGINX_BACKUP="${NGINX_PATH}.backup-${STAMP}"; cp -a "$NGINX_PATH" "$NGINX_BACKUP"; fi
NGINX_TMP="$(mktemp)"
cat > "$NGINX_TMP" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $SERVER_NAME;

    ssl_certificate $CERT_PATH;
    ssl_certificate_key $KEY_PATH;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600;
    }
}
EOF
install -m 0644 "$NGINX_TMP" "$NGINX_PATH"
rm -f "$NGINX_TMP"
ln -sfn "$NGINX_PATH" "$NGINX_LINK"
NGINX_INSTALLED=true
nginx -t
systemctl enable nginx
systemctl restart nginx

HTTPS_READY=false
for _ in {1..30}; do
  if curl --silent --fail --insecure --max-time 3 --resolve "${SERVER_NAME}:443:127.0.0.1" "https://${SERVER_NAME}/api/health" | grep -q '"status":"ok"'; then HTTPS_READY=true; break; fi
  sleep 1
done
[[ "$HTTPS_READY" == true ]] || { journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true; journalctl -u nginx -n 80 --no-pager >&2 || true; false; }

echo "[7/7] Финальная настройка…"
if [[ "$OPEN_FIREWALL" == true ]] && command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 'Nginx Full'
fi

trap - ERR
DISPLAY_HOST="$SERVER_NAME"
cat <<EOF

Kotoba Room установлен и запущен.
Адрес: https://${DISPLAY_HOST}/
Сертификат: $CERT_PATH
Важно: сертификат самоподписанный — при первом открытии браузер покажет предупреждение.

Статус: sudo systemctl status $SERVICE_NAME
Логи:   sudo journalctl -u $SERVICE_NAME -f
EOF
