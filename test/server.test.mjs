import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connectSocket } from 'socket.io-client';
import { createWorkbookServer } from '../server.mjs';

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'jp-workbook-'));
  const instance = await createWorkbookServer({ dataDir, port: 0 });
  await instance.start();
  const base = `http://127.0.0.1:${instance.port}`;
  const request = async (url, options = {}) => {
    const response = await fetch(base + url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json();
    return { response, body };
  };
  return { ...instance, base, request, cleanup: async () => { await instance.stop(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function register(f, login, role) {
  const { response, body } = await f.request('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ login, displayName: login, role })
  });
  assert.equal(response.status, 201);
  return body;
}

function auth(token) { return { authorization: `Bearer ${token}` }; }

async function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), 2000);
    socket.once(event, value => { clearTimeout(timer); resolve(value); });
  });
}

test('регистрация сохраняет роль, а вход по логину выдаёт новую сессию', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const teacher = await register(f, 'sensei', 'teacher');
  assert.equal(teacher.user.role, 'teacher');

  const { response, body } = await f.request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ login: 'sensei' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.user.login, 'sensei');
  assert.notEqual(body.token, teacher.token);
});

test('нельзя зарегистрировать повторный логин или неизвестную роль', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await register(f, 'mika', 'student');
  const duplicate = await f.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ login: 'MIKA', role: 'teacher' }) });
  assert.equal(duplicate.response.status, 409);
  const badRole = await f.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ login: 'x', role: 'admin' }) });
  assert.equal(badRole.response.status, 400);
});

test('только учитель создаёт комнату, ученик входит строго по приглашению', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const teacher = await register(f, 'teacher1', 'teacher');
  const student = await register(f, 'student1', 'student');

  const denied = await f.request('/api/rooms', { method: 'POST', headers: auth(student.token), body: JSON.stringify({ title: 'Урок' }) });
  assert.equal(denied.response.status, 403);

  const made = await f.request('/api/rooms', { method: 'POST', headers: auth(teacher.token), body: JSON.stringify({ title: 'て-форма' }) });
  assert.equal(made.response.status, 201);
  assert.ok(made.body.room.inviteToken);

  const joined = await f.request(`/api/invites/${made.body.room.inviteToken}/join`, { method: 'POST', headers: auth(student.token), body: '{}' });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.body.room.studentId, student.user.id);
});

test('ответ ученика мгновенно приходит учителю и сохраняется', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const teacher = await register(f, 'teacher2', 'teacher');
  const student = await register(f, 'student2', 'student');
  const made = await f.request('/api/rooms', { method: 'POST', headers: auth(teacher.token), body: JSON.stringify({ title: 'Совместный урок' }) });
  const room = made.body.room;
  await f.request(`/api/invites/${room.inviteToken}/join`, { method: 'POST', headers: auth(student.token), body: '{}' });

  const teacherSocket = connectSocket(f.base, { auth: { token: teacher.token }, transports: ['websocket'] });
  const studentSocket = connectSocket(f.base, { auth: { token: student.token }, transports: ['websocket'] });
  t.after(() => { teacherSocket.close(); studentSocket.close(); });
  await Promise.all([waitFor(teacherSocket, 'connect'), waitFor(studentSocket, 'connect')]);
  teacherSocket.emit('room:join', { roomId: room.id });
  studentSocket.emit('room:join', { roomId: room.id });
  await new Promise(resolve => setTimeout(resolve, 30));

  const update = waitFor(teacherSocket, 'answer:updated');
  studentSocket.emit('answer:update', { roomId: room.id, exerciseId: 'form-kau', value: 'かって' });
  const event = await update;
  assert.equal(event.exerciseId, 'form-kau');
  assert.equal(event.value, 'かって');

  const state = await f.request(`/api/rooms/${room.id}`, { headers: auth(teacher.token) });
  assert.equal(state.body.room.answers['form-kau'].value, 'かって');
});

test('учитель может оставить обратную связь, ученик получает её сразу', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const teacher = await register(f, 'teacher3', 'teacher');
  const student = await register(f, 'student3', 'student');
  const made = await f.request('/api/rooms', { method: 'POST', headers: auth(teacher.token), body: JSON.stringify({ title: 'Проверка' }) });
  const room = made.body.room;
  await f.request(`/api/invites/${room.inviteToken}/join`, { method: 'POST', headers: auth(student.token), body: '{}' });

  const teacherSocket = connectSocket(f.base, { auth: { token: teacher.token }, transports: ['websocket'] });
  const studentSocket = connectSocket(f.base, { auth: { token: student.token }, transports: ['websocket'] });
  t.after(() => { teacherSocket.close(); studentSocket.close(); });
  await Promise.all([waitFor(teacherSocket, 'connect'), waitFor(studentSocket, 'connect')]);
  teacherSocket.emit('room:join', { roomId: room.id });
  studentSocket.emit('room:join', { roomId: room.id });
  await new Promise(resolve => setTimeout(resolve, 30));

  const feedback = waitFor(studentSocket, 'feedback:updated');
  teacherSocket.emit('feedback:update', { roomId: room.id, exerciseId: 'form-kau', status: 'correct', comment: 'よくできました！' });
  const event = await feedback;
  assert.equal(event.status, 'correct');
  assert.equal(event.comment, 'よくできました！');
});
