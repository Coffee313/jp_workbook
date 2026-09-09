import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROLES = new Set(['teacher', 'student']);
const LOGIN_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.data = { users: [], sessions: {}, rooms: [] };
    this.writeChain = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  save() {
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(temp, this.file);
    });
    return this.writeChain;
  }
}

function cleanLogin(value) { return String(value || '').trim().toLowerCase(); }
function cleanText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function publicUser(user) { return { id: user.id, login: user.login, displayName: user.displayName, role: user.role }; }
function issueSession(store, userId) {
  const token = randomBytes(32).toString('base64url');
  store.data.sessions[token] = { userId, createdAt: new Date().toISOString() };
  return token;
}
function findUserByToken(store, token) {
  const session = token && store.data.sessions[token];
  return session ? store.data.users.find(user => user.id === session.userId) : null;
}
function roomView(store, room) {
  const teacher = store.data.users.find(user => user.id === room.teacherId);
  const student = store.data.users.find(user => user.id === room.studentId);
  return {
    ...room,
    teacher: teacher ? publicUser(teacher) : null,
    student: student ? publicUser(student) : null
  };
}
function canAccess(room, user) { return room && (room.teacherId === user.id || room.studentId === user.id); }

export async function createWorkbookServer({
  dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'),
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '127.0.0.1'
} = {}) {
  const store = new JsonStore(dataDir);
  await store.load();
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: false } });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  function auth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = findUserByToken(store, token);
    if (!user) return res.status(401).json({ error: 'Нужно войти в аккаунт.' });
    req.user = user;
    req.token = token;
    next();
  }

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/register', async (req, res) => {
    const login = cleanLogin(req.body?.login);
    const role = cleanText(req.body?.role, 20);
    const displayName = cleanText(req.body?.displayName || login, 60);
    if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Логин: 2–32 буквы, цифры, точка, дефис или подчёркивание.' });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Выберите роль ученика или учителя.' });
    if (!displayName) return res.status(400).json({ error: 'Укажите имя.' });
    if (store.data.users.some(user => user.login === login)) return res.status(409).json({ error: 'Такой логин уже занят.' });
    const user = { id: randomUUID(), login, displayName, role, createdAt: new Date().toISOString() };
    store.data.users.push(user);
    const token = issueSession(store, user.id);
    await store.save();
    res.status(201).json({ token, user: publicUser(user) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const login = cleanLogin(req.body?.login);
    const user = store.data.users.find(item => item.login === login);
    if (!user) return res.status(404).json({ error: 'Пользователь с таким логином не найден.' });
    const token = issueSession(store, user.id);
    await store.save();
    res.json({ token, user: publicUser(user) });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
  app.post('/api/auth/logout', auth, async (req, res) => {
    delete store.data.sessions[req.token];
    await store.save();
    res.json({ ok: true });
  });

  app.get('/api/rooms', auth, (req, res) => {
    const rooms = store.data.rooms.filter(room => canAccess(room, req.user)).map(room => roomView(store, room));
    res.json({ rooms });
  });

  app.post('/api/rooms', auth, async (req, res) => {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Комнату может создать только учитель.' });
    const now = new Date().toISOString();
    const room = {
      id: randomUUID(), inviteToken: randomBytes(18).toString('base64url'),
      title: cleanText(req.body?.title || 'Урок по て-форме', 80),
      teacherId: req.user.id, studentId: null, answers: {}, feedback: {},
      createdAt: now, updatedAt: now
    };
    store.data.rooms.push(room);
    await store.save();
    res.status(201).json({ room: roomView(store, room) });
  });

  app.get('/api/invites/:token', (req, res) => {
    const room = store.data.rooms.find(item => item.inviteToken === req.params.token);
    if (!room) return res.status(404).json({ error: 'Приглашение не найдено или устарело.' });
    const teacher = store.data.users.find(user => user.id === room.teacherId);
    res.json({ invite: { token: room.inviteToken, title: room.title, teacherName: teacher?.displayName || 'Учитель', occupied: Boolean(room.studentId) } });
  });

  app.post('/api/invites/:token/join', auth, async (req, res) => {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'По приглашению входит аккаунт ученика.' });
    const room = store.data.rooms.find(item => item.inviteToken === req.params.token);
    if (!room) return res.status(404).json({ error: 'Приглашение не найдено или устарело.' });
    if (room.studentId && room.studentId !== req.user.id) return res.status(409).json({ error: 'В этой комнате уже есть ученик.' });
    room.studentId = req.user.id;
    room.updatedAt = new Date().toISOString();
    await store.save();
    io.to(`room:${room.id}`).emit('room:updated', roomView(store, room));
    res.json({ room: roomView(store, room) });
  });

  app.get('/api/rooms/:id', auth, (req, res) => {
    const room = store.data.rooms.find(item => item.id === req.params.id);
    if (!canAccess(room, req.user)) return res.status(404).json({ error: 'Комната не найдена.' });
    res.json({ room: roomView(store, room) });
  });

  io.use((socket, next) => {
    const user = findUserByToken(store, socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  });

  io.on('connection', socket => {
    socket.on('room:join', payload => {
      const room = store.data.rooms.find(item => item.id === payload?.roomId);
      if (!canAccess(room, socket.user)) return socket.emit('room:error', { error: 'Нет доступа к комнате.' });
      socket.join(`room:${room.id}`);
      socket.data.roomId = room.id;
      io.to(`room:${room.id}`).emit('presence:updated', { userId: socket.user.id, role: socket.user.role, online: true });
    });

    socket.on('answer:update', async payload => {
      const room = store.data.rooms.find(item => item.id === payload?.roomId);
      if (!canAccess(room, socket.user) || socket.user.role !== 'student') return socket.emit('room:error', { error: 'Ответы изменяет ученик.' });
      const exerciseId = cleanText(payload?.exerciseId, 80);
      if (!exerciseId) return;
      const answer = { value: String(payload?.value ?? '').slice(0, 4000), updatedAt: new Date().toISOString(), userId: socket.user.id };
      room.answers[exerciseId] = answer;
      room.updatedAt = answer.updatedAt;
      await store.save();
      io.to(`room:${room.id}`).emit('answer:updated', { roomId: room.id, exerciseId, ...answer });
    });

    socket.on('feedback:update', async payload => {
      const room = store.data.rooms.find(item => item.id === payload?.roomId);
      if (!canAccess(room, socket.user) || socket.user.role !== 'teacher') return socket.emit('room:error', { error: 'Обратную связь оставляет учитель.' });
      const exerciseId = cleanText(payload?.exerciseId, 80);
      if (!exerciseId) return;
      const allowed = new Set(['unreviewed', 'correct', 'retry']);
      const feedback = {
        status: allowed.has(payload?.status) ? payload.status : 'unreviewed',
        comment: cleanText(payload?.comment, 1000), updatedAt: new Date().toISOString(), userId: socket.user.id
      };
      room.feedback[exerciseId] = feedback;
      room.updatedAt = feedback.updatedAt;
      await store.save();
      io.to(`room:${room.id}`).emit('feedback:updated', { roomId: room.id, exerciseId, ...feedback });
    });

    socket.on('disconnect', () => {
      if (socket.data.roomId) io.to(`room:${socket.data.roomId}`).emit('presence:updated', { userId: socket.user.id, role: socket.user.role, online: false });
    });
  });

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('*splat', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  let actualPort = null;
  return {
    app, io, store, httpServer,
    get port() { return actualPort; },
    async start() {
      if (httpServer.listening) return actualPort;
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => { actualPort = httpServer.address().port; resolve(); });
      });
      return actualPort;
    },
    async stop() {
      await store.writeChain;
      await new Promise(resolve => io.close(resolve));
      if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createWorkbookServer();
  await server.start();
  console.log(`JP Workbook: http://localhost:${server.port}`);
}
