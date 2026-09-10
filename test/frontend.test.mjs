import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('воркбук содержит все ключевые разделы материала по て-форме', async () => {
  const content = await read('workbook-data.js');
  for (const phrase of ['て-форма глаголов', '〜てください', 'Последовательность действий', 'Действие в процессе', 'Результирующее состояние', 'Регулярное действие']) {
    assert.match(content, new RegExp(phrase));
  }
  for (const form of ['かって', 'よんで', 'はなして', 'かいて', 'いって', 'およいで', 'して', 'きて']) {
    assert.ok(content.includes(form), `нет формы ${form}`);
  }
});

test('страница имеет доступные формы авторизации и комнаты', async () => {
  const html = await read('index.html');
  assert.match(html, /id="auth-view"/);
  assert.match(html, /id="room-view"/);
  assert.match(html, /name="role"/);
  assert.match(html, /aria-live="polite"/);
});

test('мобильная раскладка не допускает горизонтального переполнения', async () => {
  const css = await read('styles.css');
  assert.match(css, /minmax\(0,\s*1fr\)/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /width:\s*100%/);
});

test('основной шрифт содержит японские глифы во всём интерфейсе', async () => {
  const [html, css] = await Promise.all([read('index.html'), read('styles.css')]);
  assert.match(html, /Noto\+Sans\+JP/);
  assert.match(css, /--sans:\s*"Noto Sans JP"/);
});

test('ученик не получает автоматический вердикт, а меню следует за прокруткой', async () => {
  const [app, css] = await Promise.all([read('app.js'), read('styles.css')]);
  assert.doesNotMatch(app, /showAutoResult|correctAnswer/);
  assert.match(app, /sectionScrollHandler/);
  assert.match(app, /getBoundingClientRect\(\)\.top/);
  assert.match(css, /\.site-header\{[^}]*position:sticky;top:0/);
  assert.match(css, /\.lesson-aside\{[^}]*position:sticky;top:76px;height:calc\(100vh - 76px\)/);
});

test('клиент применяет снимок присутствия уже подключённого учителя', async () => {
  const app = await read('app.js');
  assert.match(app, /presence:snapshot/);
  assert.match(app, /payload\.userIds\.includes\(peer\.id\)/);
});
