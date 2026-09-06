import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createWorkbookServer } from '../server.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'jp-workbook-qa-'));
const outDir = path.resolve('artifacts');
await mkdir(outDir, { recursive: true });
const server = await createWorkbookServer({ dataDir, port: 0 });
await server.start();
const origin = `http://127.0.0.1:${server.port}`;
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, headless:true, args:['--no-sandbox'] });
try {
  const teacherContext = await browser.newContext({ viewport:{ width:1440, height:1000 }, permissions:['clipboard-read','clipboard-write'] });
  const teacher = await teacherContext.newPage();
  const teacherErrors = []; teacher.on('pageerror', error => teacherErrors.push(error.message));
  await teacher.goto(origin);
  await teacher.getByRole('button', { name:'Регистрация' }).click();
  await teacher.locator('#register-form input[name="displayName"]').fill('Сато-сэнсэй');
  await teacher.locator('#register-form input[name="login"]').fill('sato');
  await teacher.locator('#register-form input[value="teacher"]').check();
  await teacher.getByRole('button', { name:/Создать аккаунт/ }).click();
  await teacher.getByRole('heading', { name:/Здравствуйте/ }).waitFor();
  await teacher.getByRole('button', { name:'Создать комнату' }).click();
  await teacher.locator('#room-title').waitFor();
  await teacher.getByRole('button', { name:'Скопировать приглашение' }).click();
  const inviteUrl = await teacher.evaluate(() => navigator.clipboard.readText());
  assert.match(inviteUrl, /\/invite\//);

  const studentContext = await browser.newContext({ viewport:{ width:390, height:844 } });
  const student = await studentContext.newPage();
  const studentErrors = []; student.on('pageerror', error => studentErrors.push(error.message));
  await student.goto(inviteUrl);
  await student.getByRole('button', { name:'Регистрация' }).click();
  await student.locator('#register-form input[name="displayName"]').fill('Мика');
  await student.locator('#register-form input[name="login"]').fill('mika');
  await student.getByRole('button', { name:/Создать аккаунт/ }).click();
  await student.getByRole('button', { name:/Войти в комнату/ }).click();
  await student.locator('#room-title').waitFor();

  const studentAnswer = student.locator('[data-answer-id="form-2"]');
  await studentAnswer.fill('かって');
  await teacher.locator('[data-answer-id="form-2"]').waitFor({ state:'visible' });
  await teacher.waitForFunction(() => document.querySelector('[data-answer-id="form-2"]')?.value === 'かって');

  const teacherFeedback = teacher.locator('[data-feedback-id="form-2"]');
  await teacherFeedback.locator('select').selectOption('correct');
  await teacherFeedback.locator('input').fill('よくできました！');
  await student.waitForFunction(() => document.querySelector('[data-feedback-id="form-2"]')?.textContent.includes('よくできました'));

  const mobileOverflow = await student.evaluate(() => ({ viewport:document.documentElement.clientWidth, page:document.documentElement.scrollWidth }));
  assert.ok(mobileOverflow.page <= mobileOverflow.viewport, `mobile overflow: ${JSON.stringify(mobileOverflow)}`);
  assert.deepEqual(teacherErrors, []);
  assert.deepEqual(studentErrors, []);
  await teacher.screenshot({ path:path.join(outDir, 'teacher-room.png'), fullPage:true });
  await student.screenshot({ path:path.join(outDir, 'student-mobile.png'), fullPage:true });
  console.log(JSON.stringify({ inviteUrl, realtimeAnswer:'かって', realtimeFeedback:'よくできました！', mobileOverflow, screenshots:['artifacts/teacher-room.png','artifacts/student-mobile.png'] }, null, 2));
  await studentContext.close(); await teacherContext.close();
} finally {
  await browser.close(); await server.stop(); await rm(dataDir, { recursive:true, force:true });
}
