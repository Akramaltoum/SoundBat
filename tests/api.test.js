// API + security tests. Starts the real server (no Discord token) in a child process with a temp data folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STARTER = path.join(ROOT, 'starter');
const H = { 'Content-Type': 'application/json', 'X-SoundBat': '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

async function startServer(dataDir, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, ['-e', "require('./index.js').ready.then((p) => console.log('PORT=' + p))"], {
    cwd: ROOT,
    env: { ...process.env, SOUNDBOARD_DATA: dataDir, PORT: String(port), DISABLE_GAME_HOTKEYS: 'true', SOUNDBAT_NO_UPDATE_CHECK: 'true', ...extraEnv },
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/PORT=\d+/.test(out); i++) await sleep(100);
  const m = out.match(/PORT=(\d+)/);
  if (!m) { p.kill(); throw new Error('server did not start:\n' + out); }
  const base = `http://localhost:${m[1]}`;
  return { p, base, port: +m[1], log: () => out, stop: () => new Promise((r) => { p.once('exit', r); p.kill(); }) };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

let S, DATA;
test.before(async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sbapi-'));
  S = await startServer(DATA);
});
test.after(async () => { await S?.stop(); });

const get = (u, opt) => fetch(S.base + u, opt).then(j);
const send = (method, u, body, headers = H) => fetch(S.base + u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);
async function state() { return (await get('/api/state')).body; }
async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out waiting');
}

test('first run: starter pack is added and measured', async () => {
  const s = await waitFor(async () => { const s = await state(); return s.sounds.every((x) => x.duration > 0) && s; });
  assert.strictEqual(s.sounds.length, 8);
  assert.deepStrictEqual(s.boards, ['Main']);
  assert.ok(s.sounds.every((x) => x.board === 'Main' && !x.broken));
  assert.strictEqual(s.overlap, true);
  assert.strictEqual(s.needsSetup, true);
  assert.ok(fs.readdirSync(path.join(DATA, 'cache')).filter((f) => f.endsWith('.pcm')).length === 8);
});

test('security: changes without the SoundBat header are blocked (CSRF)', async () => {
  const r = await fetch(S.base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(r.status, 403);
  const r2 = await fetch(S.base + '/api/sounds', { method: 'POST', body: new FormData() });
  assert.strictEqual(r2.status, 403, 'cross-site form uploads blocked too');
});

test('security: a foreign Host header (DNS rebinding) is refused', async () => {
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: S.port, path: '/api/state', headers: { Host: 'evil.example:' + S.port } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.strictEqual(status, 403);
});

test('security: GET play/stop without a key is refused', async () => {
  const s = await state();
  assert.strictEqual((await get('/api/play/' + s.sounds[0].id)).status, 405);
  assert.strictEqual((await get('/api/stop')).status, 405);
});

test('playing without a bot gives a clear, fixable message', async () => {
  const s = await state();
  const r = await send('POST', '/api/play/' + s.sounds[0].id);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Connect your bot first/);
});

test('upload: real audio is added, fake audio is rejected with a clear message', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(path.join(STARTER, 'Boing.mp3'))]), 'My Boing.mp3');
  fd.append('files', new Blob(['definitely not audio']), 'fake.mp3');
  const r = await fetch(S.base + '/api/sounds', { method: 'POST', headers: { 'X-SoundBat': '1' }, body: fd }).then(j);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.added.length, 1);
  assert.strictEqual(r.body.added[0].name, 'My Boing');
  assert.ok(r.body.added[0].duration > 0);
  assert.deepStrictEqual(r.body.failed, ['fake.mp3']);
  const s = await state();
  assert.strictEqual(s.sounds.length, 9);
  assert.ok(!fs.readdirSync(path.join(DATA, 'sounds')).some((f) => fs.readFileSync(path.join(DATA, 'sounds', f)).toString().includes('definitely not audio')), 'fake file removed');
});

test('upload: only-fake files -> error; too big -> friendly JSON error', async () => {
  const fd = new FormData();
  fd.append('files', new Blob(['nope']), 'fake.wav');
  const r = await fetch(S.base + '/api/sounds', { method: 'POST', headers: { 'X-SoundBat': '1' }, body: fd }).then(j);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Couldn't read fake.wav/);
  const big = new FormData();
  big.append('files', new Blob([Buffer.alloc(26 * 1024 * 1024)]), 'huge.mp3');
  const r2 = await fetch(S.base + '/api/sounds', { method: 'POST', headers: { 'X-SoundBat': '1' }, body: big }).then(j);
  assert.strictEqual(r2.status, 400);
  assert.match(r2.body.error, /too big/);
});

test('edit: name, volume, colour, trim and toggles are validated', async () => {
  const s = (await state()).sounds[0];
  let r = await send('PATCH', '/api/sounds/' + s.id, { name: '  Honk  ', volume: 5, color: 'red;background:url(x)', trimStart: 0.1, trimEnd: 0.8, loop: true, toggle: 1, board: 'Nope' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, 'Honk');
  assert.strictEqual(r.body.volume, 2);
  assert.strictEqual(r.body.color, null, 'invalid colour dropped');
  assert.strictEqual(r.body.board, 'Main', 'unknown board ignored');
  assert.strictEqual(r.body.trimStart, 0.1); assert.strictEqual(r.body.trimEnd, 0.8);
  assert.strictEqual(r.body.loop, true); assert.strictEqual(r.body.toggle, true);
  r = await send('PATCH', '/api/sounds/' + s.id, { trimStart: 0.9, trimEnd: 0.5 });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /end of the sound/);
  r = await send('PATCH', '/api/sounds/' + s.id, { trimEnd: 999 });
  assert.strictEqual(r.body.trimEnd, null, 'end past the sound = play to the end');
  r = await send('PATCH', '/api/sounds/' + s.id, { trimStart: 0, color: '#ff3d7f' });
  assert.strictEqual(r.body.color, '#ff3d7f');
});

test('hotkeys: one key per action across sounds, stop and random', async () => {
  const [a, b] = (await state()).sounds;
  await send('PATCH', '/api/sounds/' + a.id, { hotkey: 'Num1' });
  await send('PATCH', '/api/sounds/' + b.id, { hotkey: 'Num1' });
  let s = await state();
  assert.strictEqual(s.sounds.find((x) => x.id === a.id).hotkey, null);
  assert.strictEqual(s.sounds.find((x) => x.id === b.id).hotkey, 'Num1');
  await send('PATCH', '/api/settings', { stopHotkey: 'Num1' });
  s = await state();
  assert.strictEqual(s.stopHotkey, 'Num1');
  assert.strictEqual(s.sounds.find((x) => x.id === b.id).hotkey, null);
  await send('PATCH', '/api/settings', { randomHotkey: 'Num1' });
  s = await state();
  assert.strictEqual(s.randomHotkey, 'Num1'); assert.strictEqual(s.stopHotkey, null);
  await send('PATCH', '/api/sounds/' + a.id, { hotkey: 'Num1' });
  s = await state();
  assert.strictEqual(s.randomHotkey, null);
});

test('reorder: partial lists keep everything, in order', async () => {
  const ids = (await state()).sounds.map((x) => x.id);
  await send('POST', '/api/sounds/reorder', { ids: [ids[3], ids[0], 'bogus'] });
  const after = (await state()).sounds.map((x) => x.id);
  assert.strictEqual(after.length, ids.length);
  assert.deepStrictEqual(after.slice(0, 2), [ids[3], ids[0]]);
  assert.deepStrictEqual(after.slice(2), ids.filter((id) => id !== ids[3] && id !== ids[0]));
});

test('boards: add, reject duplicates, rename, move sounds, delete safely', async () => {
  let r = await send('POST', '/api/boards', { name: '  Memes ' });
  assert.deepStrictEqual(r.body.boards, ['Main', 'Memes']);
  r = await send('POST', '/api/boards', { name: 'memes' });
  assert.strictEqual(r.status, 400);
  const s0 = (await state()).sounds[0];
  await send('PATCH', '/api/sounds/' + s0.id, { board: 'Memes' });
  r = await send('PATCH', '/api/boards', { from: 'Memes', to: 'Bangers' });
  assert.deepStrictEqual(r.body.boards, ['Main', 'Bangers']);
  assert.strictEqual((await state()).sounds.find((x) => x.id === s0.id).board, 'Bangers');
  r = await send('DELETE', '/api/boards/Bangers');
  assert.deepStrictEqual(r.body.boards, ['Main']);
  assert.strictEqual((await state()).sounds.find((x) => x.id === s0.id).board, 'Main', 'sounds moved, not lost');
  r = await send('DELETE', '/api/boards/Main');
  assert.strictEqual(r.status, 400);
});

test('upload into a board', async () => {
  await send('POST', '/api/boards', { name: 'SFX' });
  const fd = new FormData();
  fd.append('board', 'SFX');
  fd.append('files', new Blob([fs.readFileSync(path.join(STARTER, 'Whoosh.mp3'))]), 'Swoosh.mp3');
  const r = await fetch(S.base + '/api/sounds', { method: 'POST', headers: { 'X-SoundBat': '1' }, body: fd }).then(j);
  assert.strictEqual(r.body.added[0].board, 'SFX');
});

test('settings: values are sanitised', async () => {
  await send('PATCH', '/api/settings', { idleLeave: 7, masterVolume: 9, overlap: 0, autoLevel: false, theme: { a: '#123456', b: 'nope' } });
  let s = await state();
  assert.strictEqual(s.idleLeave, 0); assert.strictEqual(s.masterVolume, 1.5);
  assert.strictEqual(s.overlap, false); assert.strictEqual(s.autoLevel, false); assert.strictEqual(s.theme, null);
  await send('PATCH', '/api/settings', { idleLeave: 15, overlap: true, autoLevel: true, masterVolume: 0.8 });
  s = await state();
  assert.strictEqual(s.idleLeave, 15);
});

test('waveform endpoint returns peaks for trimming', async () => {
  const s = (await state()).sounds[0];
  const r = await get(`/api/sounds/${s.id}/wave`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.peaks.length > 100 && r.body.duration > 0);
});

test('add from link: direct audio file and a sound-button style page', async () => {
  const mp3 = fs.readFileSync(path.join(STARTER, 'Victory.mp3'));
  const srv = http.createServer((req, res) => {
    if (req.url === '/media/win.mp3') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(mp3); }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><title>Big Win - Instant Sound Button | Site</title><button onclick="play(\'/media/win.mp3\')"></button></html>'); }
    if (req.url === '/empty') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>nothing here</html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await send('POST', '/api/sounds/url', { url: base + '/media/win.mp3' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.added[0].name, 'win');
    r = await send('POST', '/api/sounds/url', { url: base + '/page' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.added[0].name, 'Big Win');
    r = await send('POST', '/api/sounds/url', { url: base + '/empty' });
    assert.match(r.body.error, /Couldn't find a sound/);
    r = await send('POST', '/api/sounds/url', { url: 'file:///etc/passwd' });
    assert.match(r.body.error, /http/);
    r = await send('POST', '/api/sounds/url', { url: base + '/missing.mp3' });
    assert.match(r.body.error, /404/);
  } finally { srv.close(); }
});

test('live updates stream over Server-Sent Events', async () => {
  const ctrl = new AbortController();
  const r = await fetch(S.base + '/api/events', { signal: ctrl.signal });
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('\n\n') || !text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  const first = JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n', text.indexOf('data: '))));
  assert.ok(Array.isArray(first.sounds));
  text = '';
  await send('POST', '/api/boards', { name: 'Live' });
  const t = Date.now();
  while (!text.includes('"Live"') && Date.now() - t < 3000) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes('"Live"'), 'change pushed without polling');
  ctrl.abort();
});

test('Stream Deck style key links work locally with the key, and only for play/stop', async () => {
  const s = await state();
  const key = s.phone.key;
  assert.ok(key && key.length > 16);
  assert.strictEqual((await get('/api/stop?k=' + key)).status, 200);
  assert.strictEqual((await get('/api/stop?k=wrong')).status, 405);
  const r = await fetch(S.base + '/api/logout?k=' + key, { method: 'POST' });
  assert.strictEqual(r.status, 403, 'key cannot log you out');
});

test('phone remote: off by default, key + cookie when on, play/stop only, reset key', { skip: !lanIp && 'no LAN address' }, async () => {
  let s = await state();
  assert.strictEqual(s.phone.enabled, false);
  await send('PATCH', '/api/settings', { phoneRemote: true });
  s = await waitFor(async () => { const s = await state(); return s.phone.port && s; });
  assert.ok(s.phone.urls.some((u) => u.includes(lanIp)));
  const lan = `http://${lanIp}:${s.phone.port}`;
  assert.strictEqual((await fetch(lan + '/')).status, 403, 'no key, no entry');
  const first = await fetch(lan + '/?k=' + encodeURIComponent(s.phone.key), { redirect: 'manual' });
  assert.strictEqual(first.status, 302);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.match(first.headers.get('set-cookie'), /HttpOnly/);
  const withCookie = { headers: { cookie } };
  assert.strictEqual((await fetch(lan + '/', withCookie)).status, 200);
  const rs = await fetch(lan + '/api/state', withCookie).then(j);
  assert.strictEqual(rs.body.remote, true);
  assert.strictEqual(rs.body.phone, undefined, 'phone never sees the key');
  assert.strictEqual((await fetch(lan + '/api/stop', { method: 'POST', ...withCookie })).status, 200);
  for (const [m, u] of [['POST', '/api/logout'], ['POST', '/api/config'], ['PATCH', '/api/settings'], ['DELETE', '/api/sounds/' + s.sounds[0].id], ['GET', '/api/voice-members']]) {
    assert.strictEqual((await fetch(lan + u, { method: m, headers: { cookie, 'Content-Type': 'application/json', 'X-SoundBat': '1' }, body: m === 'GET' ? undefined : '{}' })).status, 403, m + ' ' + u);
  }
  await send('POST', '/api/phone/reset');
  assert.strictEqual((await fetch(lan + '/api/state', withCookie)).status, 403, 'old link stops working');
  await send('PATCH', '/api/settings', { phoneRemote: false });
  await sleep(200);
  await assert.rejects(fetch(lan + '/'), 'LAN listener closed');
});

test('delete removes the sound and its files', async () => {
  const s = (await state()).sounds.at(-1);
  const r = await send('DELETE', '/api/sounds/' + s.id);
  assert.strictEqual(r.status, 200);
  assert.ok(!fs.existsSync(path.join(DATA, 'sounds', s.file)));
  await sleep(100);
  assert.ok(!fs.existsSync(path.join(DATA, 'cache', s.id + '.pcm')));
});

test('restart keeps everything; a damaged sounds.json is set aside, not overwritten', async () => {
  const before = await state();
  await S.stop();
  S = await startServer(DATA);
  const after = await state();
  assert.deepStrictEqual(after.sounds.map((x) => x.id), before.sounds.map((x) => x.id));
  assert.deepStrictEqual(after.boards, before.boards);
  await S.stop();
  fs.writeFileSync(path.join(DATA, 'sounds.json'), '{ "sounds": [ broken');
  S = await startServer(DATA);
  assert.ok(fs.readdirSync(DATA).some((f) => /^sounds\.damaged-\d+\.json$/.test(f)), 'damaged copy kept');
  assert.match(S.log(), /damaged/);
});

test('log out with wipe clears account and sounds', async () => {
  const r = await send('POST', '/api/logout', { wipeSounds: true });
  assert.strictEqual(r.status, 200);
  const s = await state();
  assert.strictEqual(s.sounds.length, 0); assert.strictEqual(s.hasToken, false); assert.strictEqual(s.profile, null);
  assert.deepStrictEqual(s.boards, ['Main']);
});
