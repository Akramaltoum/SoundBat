// Panel UI tests in real Chromium (Playwright), against the real server with a temp data folder.
// Run with: PLAYWRIGHT_CORE=<path to playwright-core> node --test tests/ui.test.js
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
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let proc, base, browser, page, errors = [], DATA;
test.before(async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sbui-'));
  // A profile + owner so the app is past the welcome screens except for the bot token
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
  // no bot token here, so the welcome screen asks for one — step past it to test the board
  await page.waitForSelector('#welcome:not([hidden])');
  await page.evaluate(() => { document.getElementById('welcome').hidden = true; });
});
test.after(async () => { await browser?.close(); proc?.kill(); });
const api = (method, url, body) => fetch(base + url, { method, headers: H, body: body && JSON.stringify(body) }).then((r) => r.json());
const hideWelcome = () => page.evaluate(() => { const w = document.getElementById('welcome'); w.hidden = true; });

test('board renders pads with durations and no script errors', async () => {
  await page.waitForSelector('.pad[data-id]');
  assert.strictEqual(await page.locator('.pad[data-id]').count(), 8);
  assert.match(await page.locator('.pad[data-id] .dur').first().innerText(), /s$/);
  assert.strictEqual(await page.locator('#boards button').count(), 0, 'one board = no tabs');
  await page.screenshot({ path: path.join(SHOTS, '1-board.png') });
  assert.deepStrictEqual(errors, []);
});

test('search filters pads, Enter plays the first match, Escape clears', async () => {
  await page.keyboard.press('Control+f');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'search');
  await page.keyboard.type('boi');
  assert.deepStrictEqual(await page.locator('.pad[data-id] .name').allInnerTexts(), ['Boing']);
  await page.keyboard.type('xyz');
  assert.match(await page.locator('.empty').innerText(), /No sounds match/);
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.locator('.pad[data-id]').count(), 8);
});

test('errors show once instead of flashing back forever', async () => {
  await page.locator('.pad[data-id]').first().click();
  await page.waitForSelector('#err:not([hidden])');
  assert.match(await page.locator('#err').innerText(), /Connect your bot first/);
  await page.waitForSelector('#err[hidden]', { state: 'attached', timeout: 8000 });
  await sleep(3500);
  assert.strictEqual(await page.locator('#err').isHidden(), true, 'stayed hidden');
});

test('edit: rename + Enter saves (used to cancel), trim by dragging, loop toggle', async () => {
  await page.click('#editBtn');
  await page.locator('.pad[data-id]').nth(5).click(); // Drumroll (longest)
  await page.waitForSelector('#dlg[open]');
  await page.waitForFunction(() => document.getElementById('trimText').textContent.includes('Whole sound ·'));
  const box = await page.locator('#trim').boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  assert.match(await page.locator('#trimText').innerText(), /→/);
  await page.check('#fLoop');
  await page.screenshot({ path: path.join(SHOTS, '2-edit.png') });
  await page.fill('#fName', 'Big Drumroll');
  await page.press('#fName', 'Enter');
  await page.waitForSelector('#dlg:not([open])', { state: 'attached' });
  await sleep(300);
  const s = (await (await fetch(base + '/api/state')).json()).sounds[5];
  assert.strictEqual(s.name, 'Big Drumroll');
  assert.ok(s.trimStart > 0.5 && s.trimEnd < s.duration, `trim ${s.trimStart}-${s.trimEnd} of ${s.duration}`);
  assert.strictEqual(s.loop, true);
  assert.ok(await page.locator('.pad[data-id] .badges').count() >= 1, 'loop badge shown');
});

test('hotkey capture warns about plain letters', async () => {
  await page.locator('.pad[data-id]').first().click();
  await page.click('#fKey');
  await page.keyboard.press('KeyG');
  assert.match(await page.locator('#fKeyHint').innerText(), /type in chat/);
  await page.click('#fKey');
  await page.keyboard.press('Control+Numpad3');
  assert.strictEqual(await page.locator('#fKeyHint').innerText(), '');
  await page.click('#dlg button[value=save]');
  await sleep(300);
  assert.strictEqual((await (await fetch(base + '/api/state')).json()).sounds[0].hotkey, 'Ctrl+Num3');
});

test('boards: create one, move a sound there with the editor, switch tabs', async () => {
  await page.click('#boards .addb');
  await page.fill('#nameIn', 'Memes');
  await page.press('#nameIn', 'Enter');
  await page.waitForSelector('#boards button:has-text("Memes")');
  assert.strictEqual(await page.locator('.pad[data-id]').count(), 0, 'new board is empty and selected');
  await page.click('#boards button:has-text("Main")');
  await page.locator('.pad[data-id]').first().click();
  await page.selectOption('#fBoard', 'Memes');
  await page.click('#dlg button[value=save]');
  await sleep(300);
  assert.strictEqual(await page.locator('.pad[data-id]').count(), 7);
  await page.click('#boards button:has-text("Memes")');
  assert.strictEqual(await page.locator('.pad[data-id]').count(), 1);
  await page.click('#editBtn'); // done editing
  assert.strictEqual(await page.locator('#boards button').count(), 2, 'tabs stay when there are 2+ boards');
  await page.screenshot({ path: path.join(SHOTS, '3-boards.png') });
});

test('settings: new toggles save; phone tab shows a QR code', async () => {
  await page.click('#settingsBtn');
  await page.uncheck('#overlap');
  await page.selectOption('#idleLeave', '15');
  await sleep(300);
  let s = await (await fetch(base + '/api/state')).json();
  assert.strictEqual(s.overlap, false); assert.strictEqual(s.idleLeave, 15);
  await page.screenshot({ path: path.join(SHOTS, '4-settings.png') });
  await page.click('#tabPhone');
  await page.check('#phoneOn');
  await page.waitForSelector('#phoneQr svg', { timeout: 5000 });
  assert.match(await page.locator('#phoneUrl').innerText(), /^http:\/\/.+\?k=/);
  await page.screenshot({ path: path.join(SHOTS, '5-phone.png') });
  await page.click('#setupCancel');
  await page.check('#overlap').catch(() => {});
  await api('PATCH', '/api/settings', { overlap: true });
});

test('add dialog: bad link gives a readable error', async () => {
  await page.click('#boards button:has-text("Main")');
  await page.locator('.pad.add').click();
  await page.fill('#addUrl', 'not a link');
  await page.click('#addUrlBtn');
  await page.waitForFunction(() => document.getElementById('addErr').textContent.length > 0);
  assert.match(await page.locator('#addErr').innerText(), /full link/);
  await page.click('#addClose');
});

test('phone view: key link works, only play/stop controls, looks right on a phone', { skip: !lanIp && 'no LAN IP' }, async () => {
  const s = await (await fetch(base + '/api/state')).json();
  const url = s.phone.urls.find((u) => u.includes(lanIp));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const phone = await ctx.newPage();
  const perr = []; phone.on('pageerror', (e) => perr.push(e.message));
  await phone.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await phone.goto(url);
  assert.ok(!phone.url().includes('k='), 'key removed from address bar');
  await phone.waitForSelector('.pad[data-id]');
  assert.ok(await phone.locator('#editBtn').isHidden());
  assert.ok(await phone.locator('#settingsBtn').isHidden());
  assert.ok(await phone.locator('#welcome').isHidden());
  assert.strictEqual(await phone.locator('.pad.add').count(), 0);
  assert.ok(await phone.locator('#stopBtn').isVisible());
  await phone.screenshot({ path: path.join(SHOTS, '6-phone-view.png') });
  assert.deepStrictEqual(perr, []);
  await ctx.close();
});

test('no uncaught errors during the whole run', () => assert.deepStrictEqual(errors, []));
