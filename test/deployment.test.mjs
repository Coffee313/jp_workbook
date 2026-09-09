import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const installerUrl = new URL('../install.sh', import.meta.url);

test('install.sh синтаксически корректен и показывает справку без root', async () => {
  const syntax = spawnSync('bash', ['-n', installerUrl.pathname], { encoding:'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync('bash', [installerUrl.pathname, '--help'], { encoding:'utf8', env:{ ...process.env, EUID:'1000' } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /PORT/);
  assert.match(help.stdout, /BIND_ADDRESS/);
});

test('установщик создаёт systemd-сервис, проверяет готовность и умеет откатывать unit', async () => {
  const script = await readFile(installerUrl, 'utf8');
  assert.match(script, /systemctl daemon-reload/);
  assert.match(script, /systemctl enable/);
  assert.match(script, /api\/health/);
  assert.match(script, /rollback/);
  assert.match(script, /npm test/);
  assert.match(script, /openssl req/);
  assert.match(script, /listen 443 ssl/);
  assert.match(script, /proxy_set_header Upgrade/);
  assert.doesNotMatch(script, /git\s+(reset|clean)/);
});

test('установщик не создаёт конфликтующий wildcard-vhost и тихо ждёт готовность', async () => {
  const script = await readFile(installerUrl, 'utf8');
  assert.doesNotMatch(script, /SERVER_NAME="\$\{SERVER_NAME:-_\}"/);
  assert.doesNotMatch(script, /SERVER_NAME="_"/);
  assert.match(script, /systemctl restart nginx/);
  assert.match(script, /curl[^\n]+--silent/);
  assert.match(script, /--resolve "\$\{SERVER_NAME\}:443:127\.0\.0\.1"/);
});
