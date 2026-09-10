import { WORKBOOK } from './workbook-data.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  token: localStorage.getItem('jp-workbook-token') || '',
  user: null, rooms: [], room: null, socket: null,
  inviteToken: location.pathname.match(/^\/invite\/([^/]+)/)?.[1] || '',
  peerOnline: false, timers: new Map()
};

function showToast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => node.className = 'toast', 2800);
}
function showView(id) { $$('.view').forEach(view => view.classList.toggle('hidden', view.id !== id)); }
function roleName(role) { return role === 'teacher' ? 'Учитель' : 'Ученик'; }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML; }

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) }
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.error || 'Не удалось выполнить запрос.');
  return body;
}
function setSession(payload) {
  state.token = payload.token; state.user = payload.user;
  localStorage.setItem('jp-workbook-token', state.token);
}
function clearSession() {
  state.socket?.close(); state.socket = null; state.token = ''; state.user = null; state.room = null;
  localStorage.removeItem('jp-workbook-token'); history.replaceState({}, '', '/');
  $('#user-menu').classList.add('hidden'); showView('auth-view');
}

function configureAuthTabs() {
  $$('.auth-tab').forEach(button => button.addEventListener('click', () => {
    $$('.auth-tab').forEach(item => item.classList.toggle('active', item === button));
    $('#login-form').classList.toggle('hidden', button.dataset.authTab !== 'login');
    $('#register-form').classList.toggle('hidden', button.dataset.authTab !== 'register');
  }));
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      setSession(await api('/api/auth/login', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }));
      await afterLogin();
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
  $('#register-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      setSession(await api('/api/auth/register', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }));
      await afterLogin();
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
}

async function afterLogin() {
  $('#header-user').textContent = `${state.user.displayName} · ${roleName(state.user.role).toLowerCase()}`;
  $('#user-menu').classList.remove('hidden');
  connectRealtime();
  if (state.inviteToken) {
    if (state.user.role === 'student') await renderInvite();
    else { showToast('Приглашение предназначено для ученика.', true); await renderDashboard(); }
  } else await renderDashboard();
}

function connectRealtime() {
  state.socket?.close();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on('connect', () => {
    if (state.room) state.socket.emit('room:join', { roomId: state.room.id });
    updatePresence();
  });
  state.socket.on('disconnect', updatePresence);
  state.socket.on('connect_error', () => showToast('Связь с комнатой потеряна. Переподключаемся…', true));
  state.socket.on('room:error', payload => showToast(payload.error, true));
  state.socket.on('room:updated', room => {
    if (state.room?.id === room.id) { state.room = room; updateRoomHeader(); }
  });
  state.socket.on('presence:snapshot', payload => {
    if (!state.room || payload.roomId !== state.room.id) return;
    const peer = state.user.role === 'teacher' ? state.room.student : state.room.teacher;
    state.peerOnline = Boolean(peer && payload.userIds.includes(peer.id));
    updatePresence();
  });
  state.socket.on('presence:updated', payload => {
    if (!state.room || payload.userId === state.user.id) return;
    state.peerOnline = payload.online; updatePresence();
  });
  state.socket.on('answer:updated', payload => {
    if (state.room?.id !== payload.roomId) return;
    state.room.answers[payload.exerciseId] = payload;
    applyAnswer(payload.exerciseId, payload.value);
  });
  state.socket.on('feedback:updated', payload => {
    if (state.room?.id !== payload.roomId) return;
    state.room.feedback[payload.exerciseId] = payload;
    applyFeedback(payload.exerciseId, payload);
  });
}

async function renderInvite() {
  showView('dashboard-view');
  const panel = $('#invite-panel');
  try {
    const { invite } = await api(`/api/invites/${state.inviteToken}`);
    $('#teacher-create').classList.add('hidden');
    panel.classList.remove('hidden');
    panel.innerHTML = `<div><p class="kicker">Вас приглашают</p><h2>${escapeHtml(invite.title)}</h2><p>Учитель: ${escapeHtml(invite.teacherName)}${invite.occupied ? ' · комната уже занята' : ''}</p></div><button class="primary-button" id="join-invite" type="button">Войти в комнату →</button>`;
    $('#join-invite').addEventListener('click', async () => {
      try {
        const { room } = await api(`/api/invites/${state.inviteToken}/join`, { method:'POST', body:'{}' });
        history.replaceState({}, '', `/room/${room.id}`); state.inviteToken = ''; await openRoom(room.id);
      } catch (error) { showToast(error.message, true); }
    });
    await loadRooms(); renderDashboardBase();
  } catch (error) { showToast(error.message, true); state.inviteToken = ''; await renderDashboard(); }
}

function renderDashboardBase() {
  $('#dashboard-greeting').textContent = `Здравствуйте, ${state.user.displayName}`;
  $('#dashboard-role').textContent = roleName(state.user.role);
  $('#teacher-create').classList.toggle('hidden', state.user.role !== 'teacher');
  $('#room-count').textContent = `${state.rooms.length} ${state.rooms.length === 1 ? 'комната' : 'комнат'}`;
  const list = $('#rooms-list'); list.innerHTML = '';
  if (!state.rooms.length) {
    list.innerHTML = `<div class="empty-rooms">${state.user.role === 'teacher' ? 'Создайте первую комнату для совместного урока.' : 'Откройте ссылку-приглашение от учителя.'}</div>`;
    return;
  }
  state.rooms.forEach((room, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'room-card';
    const peer = state.user.role === 'teacher' ? room.student : room.teacher;
    button.innerHTML = `<span class="room-card-index">${String(index + 1).padStart(2, '0')}</span><span class="room-card-body"><h3>${escapeHtml(room.title)}</h3><p>${peer ? `${state.user.role === 'teacher' ? 'Ученик' : 'Учитель'}: ${escapeHtml(peer.displayName)}` : 'Ожидает ученика'}</p></span><span class="room-arrow">→</span>`;
    button.addEventListener('click', () => openRoom(room.id)); list.appendChild(button);
  });
}
async function loadRooms() { state.rooms = (await api('/api/rooms')).rooms; }
async function renderDashboard() {
  state.room = null; state.peerOnline = false; showView('dashboard-view'); $('#invite-panel').classList.add('hidden');
  history.replaceState({}, '', '/'); await loadRooms(); renderDashboardBase();
}

function buildSectionNav() {
  const nav = $('#section-nav'); nav.innerHTML = '';
  WORKBOOK.sections.forEach((section, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `section-link${index === 0 ? ' active' : ''}`;
    button.innerHTML = `<b>${section.number}</b><span>${escapeHtml(section.title)}</span>`;
    button.addEventListener('click', () => document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior:'smooth' }));
    nav.appendChild(button);
  });
}
function setupSectionObserver() {
  if (state.sectionScrollHandler) window.removeEventListener('scroll', state.sectionScrollHandler);
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const sections = $$('.lesson-section');
    if (!sections.length) return;
    const marker = Math.min(window.innerHeight * .32, 300);
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= marker) active = section;
      else break;
    }
    $$('.section-link').forEach((button, index) => button.classList.toggle('active', WORKBOOK.sections[index].id === active.dataset.section));
  };
  state.sectionScrollHandler = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', state.sectionScrollHandler, { passive:true });
  update();
}

function answerValue(id) { return state.room.answers?.[id]?.value ?? ''; }
function feedbackValue(id) { return state.room.feedback?.[id] || { status:'unreviewed', comment:'' }; }
function makeAnswerControl(item, type) {
  const teacher = state.user.role === 'teacher';
  const wrapper = document.createElement('div'); wrapper.className = 'answer-control';
  let control;
  if (type === 'choice') {
    const choices = document.createElement('div'); choices.className = 'choice-list';
    item.options.forEach(option => {
      const label = document.createElement('label'); label.className = 'choice-option';
      label.innerHTML = `<input type="radio" name="${item.id}" value="${escapeHtml(option)}" ${answerValue(item.id) === option ? 'checked' : ''} ${teacher ? 'disabled' : ''}><span>${escapeHtml(option)}</span>`;
      choices.appendChild(label);
    });
    control = choices; wrapper.appendChild(control);
  } else if (type === 'free') {
    control = document.createElement('textarea'); control.placeholder = 'Ответ ученика…'; control.value = answerValue(item.id); control.readOnly = teacher; wrapper.appendChild(control);
  } else {
    control = document.createElement('input'); control.type = 'text'; control.placeholder = teacher ? 'Ученик ещё не ответил' : 'Введите ответ…'; control.value = answerValue(item.id); control.readOnly = teacher; control.autocomplete = 'off'; control.spellcheck = false; wrapper.appendChild(control);
  }
  const inputs = control.matches?.('input,textarea,select') ? [control] : [...control.querySelectorAll('input')];
  inputs.forEach(input => {
    input.dataset.answerId = item.id;
    if (!teacher) input.addEventListener(type === 'choice' ? 'change' : 'input', event => queueAnswer(item, event.target.value));
  });
  return wrapper;
}
function queueAnswer(item, value) {
  state.room.answers[item.id] = { value };
  clearTimeout(state.timers.get(`answer:${item.id}`));
  state.timers.set(`answer:${item.id}`, setTimeout(() => state.socket.emit('answer:update', { roomId:state.room.id, exerciseId:item.id, value }), 180));
}
function makeFeedback(id) {
  const box = document.createElement('div'); box.className = 'feedback-box'; box.dataset.feedbackId = id;
  const value = feedbackValue(id);
  if (state.user.role === 'teacher') {
    box.innerHTML = `<p>Пометка учителя</p><div class="feedback-controls"><select><option value="unreviewed">Не проверено</option><option value="correct">Всё верно</option><option value="retry">Нужно исправить</option></select><input type="text" maxlength="1000" placeholder="Комментарий ученику…"></div>`;
    const select = box.querySelector('select'), input = box.querySelector('input'); select.value = value.status; input.value = value.comment;
    const send = () => {
      clearTimeout(state.timers.get(`feedback:${id}`));
      state.timers.set(`feedback:${id}`, setTimeout(() => state.socket.emit('feedback:update', { roomId:state.room.id, exerciseId:id, status:select.value, comment:input.value }), 220));
    };
    select.addEventListener('change', send); input.addEventListener('input', send);
  } else renderFeedbackDisplay(box, value);
  return box;
}
function renderFeedbackDisplay(box, value) {
  const labels = { unreviewed:'Ещё не проверено', correct:'Учитель: всё верно', retry:'Учитель просит исправить' };
  box.className = `feedback-box feedback-display ${value.status || 'unreviewed'}`;
  box.innerHTML = `<b>${labels[value.status] || labels.unreviewed}</b>${value.comment ? `<span>${escapeHtml(value.comment)}</span>` : '<span class="teacher-empty">Комментариев пока нет</span>'}`;
}

function renderExercise(exercise) {
  const card = document.createElement('article'); card.className = 'exercise-card';
  card.innerHTML = `<div class="exercise-top"><div><h3>${escapeHtml(exercise.title)}</h3><p>${escapeHtml(exercise.instruction)}</p></div><span class="sync-label">● синхронизация включена</span></div>`;
  exercise.items.forEach(item => {
    const row = document.createElement('div'); row.className = 'answer-row'; row.dataset.rowId = item.id;
    row.innerHTML = `<div class="answer-prompt"><span class="jp">${escapeHtml(item.prompt)}</span>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}</div>`;
    row.appendChild(makeAnswerControl(item, exercise.type)); row.appendChild(makeFeedback(item.id)); card.appendChild(row);
  });
  return card;
}
function renderWorkbook() {
  const content = $('#lesson-content'); content.innerHTML = '';
  WORKBOOK.sections.forEach(section => {
    const node = document.createElement('section'); node.className = 'lesson-section'; node.id = `section-${section.id}`; node.dataset.section = section.id;
    node.innerHTML = `<div class="section-heading"><span class="section-number">${section.number}</span><div><div class="eyebrow">${escapeHtml(section.eyebrow)}</div><h2>${escapeHtml(section.title)}</h2></div></div><p class="section-lead">${escapeHtml(section.lead)}</p><details class="reference" open><summary>参考 · ${escapeHtml(section.reference.title)}</summary><div class="reference-body">${section.reference.html}</div></details>`;
    section.exercises.forEach(exercise => node.appendChild(renderExercise(exercise))); content.appendChild(node);
  });
  setupSectionObserver();
}
function updateRoomHeader() {
  if (!state.room) return;
  $('#room-title').textContent = state.room.title;
  $('#room-role-label').textContent = state.user.role === 'teacher' ? 'Режим учителя · ответы видны в реальном времени' : 'Режим ученика · изменения сохраняются автоматически';
  const teacher = state.room.teacher?.displayName || '—', student = state.room.student?.displayName || 'ещё не вошёл';
  $('#room-participants').textContent = `Учитель: ${teacher} · Ученик: ${student}`;
  $('#copy-invite').classList.toggle('hidden', state.user.role !== 'teacher');
  updatePresence();
}
function updatePresence() {
  if (!state.room) return;
  const connected = Boolean(state.socket?.connected), online = connected && state.peerOnline;
  $('#presence-dot').classList.toggle('online', online);
  $('#presence-label').textContent = !connected ? 'Нет соединения' : online ? 'Оба в комнате' : 'Вы в комнате';
  const peer = state.user.role === 'teacher' ? state.room.student : state.room.teacher;
  $('#presence-person').textContent = peer ? `${peer.displayName}${online ? ' онлайн' : ' не в сети'}` : 'Ожидаем ученика';
}
function applyAnswer(id, value) {
  const controls = $$(`[data-answer-id="${CSS.escape(id)}"]`);
  controls.forEach(control => {
    if (control.type === 'radio') control.checked = control.value === value;
    else if (document.activeElement !== control || state.user.role === 'teacher') control.value = value;
  });
}
function applyFeedback(id, value) {
  const box = document.querySelector(`[data-feedback-id="${CSS.escape(id)}"]`); if (!box) return;
  if (state.user.role === 'student') renderFeedbackDisplay(box, value);
  else { box.querySelector('select').value = value.status; if (document.activeElement !== box.querySelector('input')) box.querySelector('input').value = value.comment; }
}
async function openRoom(id) {
  try {
    state.room = (await api(`/api/rooms/${id}`)).room; state.peerOnline = false;
    history.replaceState({}, '', `/room/${id}`); showView('room-view'); buildSectionNav(); renderWorkbook(); updateRoomHeader();
    state.socket?.emit('room:join', { roomId:id }); window.scrollTo({ top:0 });
  } catch (error) { showToast(error.message, true); await renderDashboard(); }
}

$('#create-room-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const { room } = await api('/api/rooms', { method:'POST', body:JSON.stringify(body) });
    state.rooms.unshift(room); renderDashboardBase(); showToast('Комната создана'); await openRoom(room.id);
  } catch (error) { showToast(error.message, true); }
});
$('#copy-invite').addEventListener('click', async () => {
  const url = `${location.origin}/invite/${state.room.inviteToken}`;
  try { await navigator.clipboard.writeText(url); showToast('Ссылка скопирована'); }
  catch { window.prompt('Скопируйте ссылку:', url); }
});
$('#back-dashboard').addEventListener('click', renderDashboard);
$('#brand-home').addEventListener('click', () => state.user ? renderDashboard() : showView('auth-view'));
$('#logout-button').addEventListener('click', async () => { try { await api('/api/auth/logout', { method:'POST', body:'{}' }); } catch {} clearSession(); });
configureAuthTabs();
document.documentElement.dataset.appReady = '1';

(async function boot() {
  if (!state.token) { showView('auth-view'); return; }
  try { state.user = (await api('/api/me')).user; await afterLogin(); }
  catch { clearSession(); }
})();
