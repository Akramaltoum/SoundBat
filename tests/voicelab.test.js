// Voice Lab end-to-end in real Chromium: engine download card, generate a take, preview, save it to the board.
// Run with: PLAYWRIGHT_CORE=<path to playwright-core> node --test tests/voicelab.test.js
// Downloads the real voice engine (~90 MB) into a temp folder, so it needs internet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'sb-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'X-SoundBat': '1' };

let proc, base, browser, page, errors = [], DATA;
test.before(async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sbvl-'));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ownerId: '123456789012345678', profile: { name: 'Tester', color: '#8b5cff' } }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  proc = spawn(process.execPath, ['-e', "require('./index.js').ready.then((p) => console.log('PORT=' + p))"], {
    cwd: ROOT, env: { ...process.env, SOUNDBOARD_DATA: DATA, PORT: String(port), DISABLE_GAME_HOTKEYS: 'true', SOUNDBAT_NO_UPDATE_CHECK: 'true' } });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/PORT=\d+/.test(out); i++) await sleep(100);
  base = 'http://localhost:' + out.match(/PORT=(\d+)/)[1];
  for (let i = 0; i < 100; i++) { const s = await (await fetch(base + '/api/state')).json(); if (s.sounds.length === 8 && s.sounds.every((x) => x.duration)) break; await sleep(150); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  page = await browser.newPage({ viewport: { width: 940, height: 640 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|404|status of 400/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base);
  await page.waitForSelector('#welcome:not([hidden])');
  await page.evaluate(() => { document.getElementById('welcome').hidden = true; });
});
test.after(async () => { await browser?.close(); proc?.kill(); });
const api = (method, url, body) => fetch(base + url, { method, headers: H, body: body && JSON.stringify(body) }).then((r) => r.json());

test('Voice Lab tab opens and asks for the one-time engine download', async () => {
  await page.click('#viewLab');
  await page.waitForSelector('#lab:not([hidden])');
  assert.ok(await page.locator('#grid').isHidden(), 'board hidden while in Voice Lab');
  await page.waitForSelector('#labEngine:not([hidden])');
  assert.ok(await page.locator('#labGo').isDisabled());
  assert.ok(await page.locator('#labVoice option').count() >= 28);
  assert.ok(await page.locator('#labFx button').count() >= 15);
  assert.ok(await page.locator('#labAfter option').count() >= 9, 'board sounds offered as before/after');
  await page.screenshot({ path: path.join(SHOTS, 'vl-1-setup.png') });
});

test('engine downloads and Generate unlocks', { timeout: 300_000 }, async () => {
  await page.click('#labDownload');
  await page.waitForSelector('#labMeter:not([hidden])', { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, 'vl-2-downloading.png') });
  await page.waitForSelector('#labEngine[hidden]', { state: 'attached', timeout: 280_000 });
  assert.ok(await page.locator('#labGo').isEnabled());
  assert.ok(fs.existsSync(path.join(DATA, 'models', 'kokoro-v1.0.int8.onnx')));
});

test('typing pauses in-game hotkeys; Ctrl+Enter generates a take that previews', { timeout: 300_000 }, async () => {
  await page.fill('#labText', 'Ladies and gentlemen… we got him!');
  assert.match(await page.locator('#labCount').innerText(), /^33 \//);
  await page.selectOption('#labVoice', 'bm_george');
  await page.click('#labFx button[data-id=stadium]');
  await page.selectOption('#labAfter', { label: 'Air Horn' });
  await page.locator('#labPitch').fill('-3');
  await page.focus('#labText');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#labGo .labBusy');
  await page.screenshot({ path: path.join(SHOTS, 'vl-3-generating.png') });
  await page.waitForSelector('#labTakes .take', { timeout: 280_000 });
  const meta = await page.locator('#labTakes .take .tmeta').first().innerText();
  assert.match(meta, /George/); assert.match(meta, /Stadium/); assert.match(meta, /-3 pitch/);
  const url = await page.evaluate(() => lab.takes[0].url);
  const r = await fetch(base + url);
  assert.strictEqual(r.status, 200);
  assert.ok((await r.arrayBuffer()).byteLength > 20_000, 'clip has audio');
  await page.screenshot({ path: path.join(SHOTS, 'vl-4-take.png') });
});

test('Surprise me fills a line; second take stacks on top; settings reload from a take', { timeout: 300_000 }, async () => {
  await page.click('#labSurprise');
  assert.ok((await page.inputValue('#labText')).length > 3);
  await page.fill('#labText', 'Skill issue.');
  await page.selectOption('#labBlend', 'af_bella');
  assert.ok(await page.locator('#labMixRow').isVisible());
  await page.click('#labGo');
  await page.waitForFunction(() => document.querySelectorAll('#labTakes .take').length === 2, null, { timeout: 280_000 });
  assert.match(await page.locator('#labTakes .take .ttext').first().innerText(), /Skill issue/);
  await page.locator('#labTakes .take .ttext').nth(1).click(); // load the first take's settings back
  assert.strictEqual(await page.inputValue('#labVoice'), 'bm_george');
  assert.strictEqual(await page.inputValue('#labBlend'), '');
});

test('save a take to the board with a custom name', async () => {
  const before = (await api('GET', '/api/state')).sounds.length;
  await page.locator('#labTakes .take [data-a=save]').first().click();
  await page.locator('#labTakes .take .tsave input').first().fill('Skill Issue (Bella mix)');
  await page.screenshot({ path: path.join(SHOTS, 'vl-5-save.png') });
  await page.locator('#labTakes .take .tsave input').first().press('Enter');
  await page.waitForSelector('#labTakes .take .saved');
  let s;
  for (let i = 0; i < 40; i++) { s = await api('GET', '/api/state'); if (s.sounds.length === before + 1 && s.sounds.at(-1).duration) break; await sleep(150); }
  assert.strictEqual(s.sounds.length, before + 1);
  assert.strictEqual(s.sounds.at(-1).name, 'Skill Issue (Bella mix)');
  assert.ok(s.sounds.at(-1).duration > 0.3);
  await page.click('#viewBoard');
  await page.waitForSelector('.pad[data-id]');
  assert.ok(await page.locator('.pad .name', { hasText: 'Skill Issue (Bella mix)' }).isVisible());
  await page.screenshot({ path: path.join(SHOTS, 'vl-6-board.png') });
});

test('API guards: empty text, unknown take, phone remote cannot use Voice Lab', async () => {
  const r1 = await fetch(base + '/api/voicelab/generate', { method: 'POST', headers: H, body: JSON.stringify({ text: ' ', voice: 'am_michael' }) });
  assert.strictEqual(r1.status, 400);
  assert.match((await r1.json()).error, /Type something/);
  const r2 = await fetch(base + '/api/voicelab/save/nope', { method: 'POST', headers: H, body: '{}' });
  assert.strictEqual(r2.status, 400);
  const r3 = await fetch(base + '/api/voicelab/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r3.status, 403, 'changes need the app header');
});

test('narrow window stacks the Voice Lab columns; no script errors', async () => {
  await page.click('#viewLab');
  await page.setViewportSize({ width: 560, height: 700 });
  await page.screenshot({ path: path.join(SHOTS, 'vl-7-narrow.png'), fullPage: true });
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 560, 'no sideways scroll');
  assert.deepStrictEqual(errors, []);
});
