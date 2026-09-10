import { chromium } from 'playwright-core';
import { io as connectSocket } from 'socket.io-client';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createWorkbookServer } from '../server.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'jp-workbook-qa-'));
const outDir = path.resolve('artifacts');
await mkdir(outDir, { recursive:true });
const server = await createWorkbookServer({ dataDir, port:0 });
await server.start();
const origin = `http://127.0.0.1:${server.port}`;

async function post(url, body, token = '') {
  const response = await fetch(origin + url, {
    method:'POST',
    headers:{ 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}) },
    body:JSON.stringify(body)
  });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}

const teacher = await post('/api/auth/register', { login:'sato', displayName:'Сато-сэнсэй', role:'teacher' });
const student = await post('/api/auth/register', { login:'mika', displayName:'Мика', role:'student' });
const { room } = await post('/api/rooms', { title:'Урок по て-форме' }, teacher.token);
await post(`/api/invites/${room.inviteToken}/join`, {}, student.token);

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
if (process.env.CHROME_LIB_PATH) process.env.LD_LIBRARY_PATH = process.env.CHROME_LIB_PATH;
const browser = await chromium.launch({ executablePath, headless:true, args:['--no-sandbox'] });
let teacherSocket;
try {
  teacherSocket = connectSocket(origin, { auth:{ token:teacher.token }, transports:['websocket'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket timeout')), 5000);
    teacherSocket.once('connect', () => { clearTimeout(timer); resolve(); });
  });
  const teacherJoined = new Promise(resolve => teacherSocket.once('presence:updated', resolve));
  teacherSocket.emit('room:join', { roomId:room.id });
  await teacherJoined;

  const context = await browser.newContext({ viewport:{ width:1440, height:1000 } });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await context.addInitScript(token => localStorage.setItem('jp-workbook-token', token), student.token);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil:'commit' });
  await page.locator('html[data-app-ready="1"]').waitFor({ state:'attached' });
  await page.getByRole('heading', { name:/Здравствуйте/ }).waitFor();
  await page.locator('.room-card').click();
  await page.locator('#room-title').waitFor();
  await page.waitForFunction(() => document.querySelector('#presence-person')?.textContent.includes('Сато-сэнсэй онлайн'));

  const answer = page.locator('[data-answer-id="form-2"]');
  await answer.fill('かって');
  assert.equal(await page.locator('[data-row-id="form-2"] .answer-result').count(), 0,
    'ученик получил элемент автоматической проверки');

  teacherSocket.emit('feedback:update', {
    roomId:room.id, exerciseId:'form-2', status:'correct', comment:'よくできました！'
  });
  await page.waitForFunction(() => document.querySelector('[data-feedback-id="form-2"]')?.textContent.includes('よくできました'));

  await page.locator('#section-sequence').evaluate(node => node.scrollIntoView({ block:'start' }));
  await page.waitForFunction(() => document.querySelectorAll('.section-link')[2]?.classList.contains('active'));
  const asideBox = await page.locator('.lesson-aside').boundingBox();
  assert.equal(Math.round(asideBox.y), 76);
  assert.equal(Math.round(asideBox.height), 924);

  const overflow = await page.evaluate(() => ({ viewport:document.documentElement.clientWidth, page:document.documentElement.scrollWidth }));
  assert.ok(overflow.page <= overflow.viewport, `overflow: ${JSON.stringify(overflow)}`);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  await page.screenshot({ path:path.join(outDir, 'student-reviewed.png'), fullPage:false });
  console.log(JSON.stringify({
    hiddenUntilTeacherReview:true,
    teacherPresence:'онлайн',
    teacherFeedback:'よくできました！',
    activeSection:'03',
    aside:{ top:Math.round(asideBox.y), height:Math.round(asideBox.height) },
    overflow,
    screenshot:'artifacts/student-reviewed.png'
  }, null, 2));
  await context.close();
} finally {
  teacherSocket?.close();
  await browser.close();
  await server.stop();
  await rm(dataDir, { recursive:true, force:true });
}
