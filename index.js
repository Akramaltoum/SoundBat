// SoundBat — a bot that joins your voice call and plays sounds you trigger
// from a Stream Deck-style panel (http://localhost:3000), in-game hotkeys, or your phone.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CODE_VERSION = '1.2.0';
const REPO = 'Akramaltoum/SoundBat';

// Bundled ffmpeg (no install scripts needed) — inside the packaged app the binary lives in app.asar.unpacked
let FFMPEG = 'ffmpeg';
try {
  FFMPEG = require('@ffmpeg-installer/ffmpeg').path.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep).replace('app.asar/', 'app.asar.unpacked/');
  process.env.PATH = path.dirname(FFMPEG) + path.delimiter + process.env.PATH;
} catch (e) { console.error('Bundled ffmpeg not found, falling back to system ffmpeg:', String(e.message || e)); }
const express = require('express');
const multer = require('multer');
const { Client, GatewayIntentBits, Events, PermissionFlagsBits } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, entersState,
} = require('@discordjs/voice');
const audio = require('./audio');

// Inside the desktop app we can use Electron extras (encrypted token, open folders)
let electron = null;
if (process.versions.electron) { try { electron = require('electron'); } catch { /* script mode */ } }
const canEncrypt = () => { try { return !!electron?.safeStorage?.isEncryptionAvailable(); } catch { return false; } };

const events = new EventEmitter(); // lets the desktop shell react to settings (tray, start with Windows)

// ---------- storage ----------
// Desktop app: data lives in the user's app-data folder. Script mode: next to this file.
const DATA_DIR = process.env.SOUNDBOARD_DATA || __dirname;
const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DB_FILE = path.join(DATA_DIR, 'sounds.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
[DATA_DIR, SOUND_DIR, CACHE_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// Write to a temp file then swap it in, so a crash mid-save can't wipe your board
function writeJSON(file, obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, data); try { fs.rmSync(tmp, { force: true }); } catch {} }
}
// A damaged file is set aside (not overwritten) so nothing is lost
function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const aside = file.replace(/\.json$/, `.damaged-${Date.now()}.json`);
    try { fs.renameSync(file, aside); } catch {}
    console.error(`${path.basename(file)} was damaged (${e.message}); kept a copy as ${path.basename(aside)}`);
    return null;
  }
}

// ---------- config (bot token, who to follow, profile) ----------
const validEnv = (v) => (v && !v.startsWith('paste_') ? v : null);
let config = { token: null, ownerId: null, profile: null, remoteKey: null };
const rawConfig = readJSON(CONFIG_FILE) || {};
config = { ...config, ...rawConfig };
if (rawConfig.tokenEnc) {
  try { config.token = electron.safeStorage.decryptString(Buffer.from(rawConfig.tokenEnc, 'base64')); }
  catch (e) { console.error("Couldn't unlock the saved bot token — connect the bot again:", e.message); config.token = null; }
}
delete config.tokenEnc;
config.token = validEnv(process.env.DISCORD_TOKEN) || config.token;
config.ownerId = validEnv(process.env.OWNER_ID) || config.ownerId;
if (!config.remoteKey) config.remoteKey = crypto.randomBytes(18).toString('base64url');

// The bot token is encrypted with your Windows login (DPAPI) when the desktop app can
function saveConfig() {
  const out = { ownerId: config.ownerId, profile: config.profile, remoteKey: config.remoteKey };
  if (config.token && canEncrypt()) out.tokenEnc = electron.safeStorage.encryptString(config.token).toString('base64');
  else out.token = config.token;
  writeJSON(CONFIG_FILE, out);
}
if ((rawConfig.token && canEncrypt()) || !rawConfig.remoteKey) saveConfig(); // upgrade old plain-text token
let OWNER_ID = config.ownerId;
const PORT = Number(process.env.PORT || 3000);

// ---------- sounds + settings ----------
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac', '.aac', '.opus'];
const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULTS = {
  masterVolume: 0.8, followMe: true, globalHotkeys: true, stopHotkey: null, randomHotkey: null, theme: null,
  overlap: true, autoLevel: true, idleLeave: 0, closeToTray: true, openAtLogin: false,
  phoneRemote: process.env.ALLOW_LAN === 'true', boards: ['Main'], sounds: [],
};
const firstRun = !fs.existsSync(DB_FILE);
let db = { ...DEFAULTS, ...(readJSON(DB_FILE) || {}) };
if (process.env.ALLOW_LAN === 'true') db.phoneRemote = true;
if (!Array.isArray(db.boards) || !db.boards.length) db.boards = ['Main'];
if (!Array.isArray(db.sounds)) db.sounds = [];

function tidySound(s) {
  s.volume = Number.isFinite(+s.volume) ? clamp(s.volume, 0, 2) : 1;
  s.hotkey = s.hotkey || null;
  s.color = HEX.test(s.color || '') ? s.color : null;
  if (!db.boards.includes(s.board)) s.board = db.boards[0];
  s.trimStart = Math.max(0, Number(s.trimStart) || 0);
  s.trimEnd = s.trimEnd == null || !(+s.trimEnd > s.trimStart) ? null : +s.trimEnd;
  s.loop = !!s.loop; s.toggle = !!s.toggle;
  return s;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
db.sounds.forEach(tidySound);

// First run: start with a small pack of original SoundBat sounds so the board isn't empty
if (firstRun) {
  const STARTER = path.join(__dirname, 'starter');
  const order = ['Air Horn', 'Ba Dum Tss', 'Bat Screech', 'Victory', 'Sad Trombone', 'Drumroll', 'Boing', 'Whoosh'];
  try {
    order.forEach((name) => {
      const src = path.join(STARTER, name + '.mp3');
      if (!fs.existsSync(src)) return;
      const id = newId();
      fs.copyFileSync(src, path.join(SOUND_DIR, id + '.mp3'));
      db.sounds.push(tidySound({ id, name, file: id + '.mp3', volume: 1 }));
    });
  } catch (e) { console.error('Starter pack failed:', e.message); }
}
function newId() { let id; do { id = crypto.randomUUID().slice(0, 8); } while (db.sounds.some((s) => s.id === id)); return id; }
const save = () => { clearTimeout(saveTimer); writeJSON(DB_FILE, db); };
let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
save();

// ---------- sound analysis (decode once, measure loudness, cache for instant playback) ----------
const pcmFile = (s) => path.join(CACHE_DIR, s.id + '.pcm');
const pcmCache = new audio.PcmCache();
const waveCache = new Map();
const analyzing = new Set();
let analysisQueue = Promise.resolve();

function needsAnalysis(s) {
  if (s.analyzed !== s.file) return true;
  return !s.long && !s.broken && !fs.existsSync(pcmFile(s));
}
function analyzeSound(s) {
  if (analyzing.has(s.id)) return analysisQueue;
  analyzing.add(s.id);
  analysisQueue = analysisQueue.then(async () => {
    const file = path.join(SOUND_DIR, s.file);
    const key = s.id + ':' + s.file;
    pcmCache.drop(key); waveCache.delete(key);
    let result;
    try {
      if (!fs.existsSync(file)) throw new Error('its audio file is missing');
      const r = await audio.analyze({ ffmpeg: FFMPEG, file, pcmFile: pcmFile(s) });
      result = { duration: r.duration, long: r.long, peakDb: r.peakDb, loudDb: r.loudDb, broken: null };
    } catch (e) {
      result = { broken: /missing/.test(e.message) ? e.message : "it isn't a playable audio file" };
      console.error(`Couldn't read "${s.name}":`, e.message);
    }
    const cur = db.sounds.find((x) => x.id === s.id);
    if (cur) { Object.assign(cur, result, { analyzed: cur.file }); saveSoon(); changed(); }
  }).finally(() => analyzing.delete(s.id));
  return analysisQueue;
}
function loadPcm(s) {
  return pcmCache.get(s.id + ':' + s.file, () => {
    try { return fs.readFileSync(pcmFile(s)); } catch { return null; }
  });
}

// ---------- discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let mixer = null;
let lastError = null, errSeq = 0;
let lastActivity = Date.now();
function setError(msg) { lastError = msg ? { msg: String(msg), id: ++errSeq } : null; changed(); }

player.on('error', (e) => { console.error('Playback error:', e.message); setError('Playback error: ' + e.message); });
player.on('stateChange', (o, n) => { if (o.status !== n.status) changed(); });

function ownerChannel() {
  if (!OWNER_ID) return null;
  for (const guild of client.guilds.cache.values()) {
    const vs = guild.voiceStates.cache.get(OWNER_ID);
    if (vs?.channel) return vs.channel;
  }
  return null;
}

function ownerMember() {
  if (!OWNER_ID || !client.isReady()) return null;
  for (const guild of client.guilds.cache.values()) {
    const m = guild.members.cache.get(OWNER_ID) || guild.voiceStates.cache.get(OWNER_ID)?.member;
    if (m) return m;
  }
  return null;
}
function ownerName() {
  const m = ownerMember();
  if (m) return m.displayName || m.user?.globalName || m.user?.username;
  const u = OWNER_ID && client.users.cache.get(OWNER_ID);
  return u ? u.globalName || u.username : null;
}
function ownerInfo() {
  if (!OWNER_ID) return null;
  let avatar = ownerMember()?.displayAvatarURL({ size: 128 }) || null;
  if (!avatar && client.isReady()) avatar = client.users.cache.get(OWNER_ID)?.displayAvatarURL({ size: 128 }) || null;
  return { id: OWNER_ID, name: ownerName(), avatar };
}

function activeConnection() {
  for (const guild of client.guilds.cache.values()) {
    const c = getVoiceConnection(guild.id);
    if (c && c.state.status !== VoiceConnectionStatus.Destroyed) return c;
  }
  return null;
}

function leave() {
  for (const guild of client.guilds.cache.values()) getVoiceConnection(guild.id)?.destroy();
  changed();
}

// Clear, fixable reasons instead of a silent timeout
function checkCanJoin(channel) {
  const me = channel.guild.members.me;
  if (!me) return;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) {
    throw new Error(`Your bat isn't allowed into #${channel.name}. In Discord, give its role the Connect permission there.`);
  }
  if (!perms.has(PermissionFlagsBits.Speak)) {
    throw new Error(`Your bat can join #${channel.name} but can't talk. Give its role the Speak permission there.`);
  }
  if (!channel.joinable) throw new Error(`#${channel.name} is full, so your bat can't get in.`);
}

async function connectTo(channel) {
  const existing = getVoiceConnection(channel.guild.id);
  if (existing && existing.joinConfig.channelId === channel.id &&
      existing.state.status !== VoiceConnectionStatus.Destroyed) {
    await entersState(existing, VoiceConnectionStatus.Ready, 15_000);
    return existing;
  }
  checkCanJoin(channel);
  // Only be in one call at a time
  for (const g of client.guilds.cache.values()) if (g.id !== channel.guild.id) getVoiceConnection(g.id)?.destroy();

  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  conn.subscribe(player);
  if (!conn.__hooked) {
    conn.__hooked = true;
    conn.on('stateChange', () => changed());
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch { conn.destroy(); }
    });
  }
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20_000); }
  catch { conn.destroy(); throw new Error("Couldn't connect to the voice channel — try again in a moment"); }
  lastActivity = Date.now();
  return conn;
}

async function joinOwner() {
  if (!client.isReady()) throw new Error(config.token ? 'Your bat is still waking up — try again in a second' : 'Connect your bot first (Settings → Account)');
  if (!OWNER_ID) throw new Error('Pick your Discord account first (Settings → Account)');
  const ch = ownerChannel();
  if (!ch) throw new Error("Join a voice channel first — your bat couldn't find you in one");
  return connectTo(ch);
}

// ---------- playback ----------
const trackVolume = (id) => () => {
  const s = db.sounds.find((x) => x.id === id);
  if (!s) return 0;
  return s.volume * db.masterVolume * (db.autoLevel ? audio.levelGain(s) : 1);
};
function makeTrack(s) {
  const common = { id: s.id, loop: s.loop, volume: trackVolume(s.id) };
  const pcm = !s.long && loadPcm(s);
  if (pcm) {
    return new audio.BufferTrack({ ...common, pcm, start: audio.secToBytes(s.trimStart),
      end: s.trimEnd == null ? null : audio.secToBytes(s.trimEnd) });
  }
  return new audio.StreamTrack({ ...common, ffmpeg: FFMPEG, file: path.join(SOUND_DIR, s.file), start: s.trimStart, end: s.trimEnd });
}
const mixing = () => mixer && !mixer.finished;
function playingIds() { return mixing() ? [...new Set(mixer.tracks.map((t) => t.id))] : []; }
function progress() {
  const out = {};
  if (mixing()) mixer.tracks.forEach((t) => { out[t.id] = { pos: +t.position.toFixed(2), dur: t.duration == null ? null : +t.duration.toFixed(2), loop: t.loop }; });
  return out;
}

let playLock = Promise.resolve(); // one play at a time, so rapid presses can't race the voice join
function play(id) {
  const run = playLock.then(() => playNow(id));
  playLock = run.catch(() => {});
  return run;
}
async function playNow(id) {
  const s = db.sounds.find((x) => x.id === id);
  if (!s) throw new Error('Sound not found');
  if (!fs.existsSync(path.join(SOUND_DIR, s.file))) throw new Error(`"${s.name}" lost its audio file — delete it and add it again`);
  if (s.broken) throw new Error(`"${s.name}" can't be played: ${s.broken}`);
  // Looping / "press again to stop" sounds toggle off when pressed while playing
  if ((s.toggle || s.loop) && mixing() && mixer.tracks.some((t) => t.id === id)) {
    mixer.tracks.filter((t) => t.id === id).forEach((t) => mixer.remove(t));
    changed();
    return { stopped: true };
  }
  await joinOwner();
  const track = makeTrack(s);
  if (mixing() && !db.overlap) mixer.clear();
  if (!mixing() || !mixer.add(track)) {
    mixer = new audio.Mixer({ onTrackEnd: () => changed() });
    mixer.add(track);
    player.play(createAudioResource(mixer, { inputType: StreamType.Opus }));
  }
  lastActivity = Date.now();
  if (needsAnalysis(s)) analyzeSound(s);
  changed();
  return { playing: id };
}
function stopAll() {
  if (mixer) { mixer.destroy(); mixer = null; }
  player.stop(true);
  changed();
}
function stopSound(id) {
  if (mixing()) mixer.tracks.filter((t) => t.id === id).forEach((t) => mixer.remove(t));
  changed();
}
let lastRandom = null;
function playRandom(ids) {
  let pool = db.sounds.filter((s) => !s.broken && (!ids || ids.includes(s.id)));
  if (pool.length > 1) pool = pool.filter((s) => s.id !== lastRandom);
  if (!pool.length) throw new Error('No sounds to pick from');
  const pick = pool[crypto.randomInt(pool.length)];
  lastRandom = pick.id;
  return play(pick.id);
}

// Leave the call after a quiet spell, if you asked for that
setInterval(() => {
  if (!db.idleLeave || mixing() || !activeConnection()) return;
  if (Date.now() - lastActivity > db.idleLeave * 60_000) { console.log('Leaving the call after being idle'); leave(); }
}, 30_000).unref();

// ---------- in-game (system-wide) hotkeys ----------
// Names match the panel's key names: A-Z, 0-9, Num0-9, NumAdd, F1-F24, Space, ArrowUp, ... with Ctrl/Alt/Shift+ prefixes.
let hook = null, hookError = null, capturePaused = false, captureTimer = null;
let hookKeyNames = null;
try {
  if (process.env.DISABLE_GAME_HOTKEYS === 'true') throw new Error('turned off in .env');
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const numlockOff = { NumpadInsert: 'Num0', NumpadEnd: 'Num1', NumpadArrowDown: 'Num2', NumpadPageDown: 'Num3',
    NumpadArrowLeft: 'Num4', NumpadArrowRight: 'Num6', NumpadHome: 'Num7', NumpadArrowUp: 'Num8',
    NumpadPageUp: 'Num9', NumpadDelete: 'NumDecimal' };
  const modifiers = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight']);
  const names = {};
  for (const [k, code] of Object.entries(UiohookKey)) names[code] = numlockOff[k] || k.replace(/^Numpad/, 'Num');
  hookKeyNames = [...new Set(Object.values(names))].filter((n) => !modifiers.has(n));
  const held = new Set();

  uIOhook.on('keydown', (e) => {
    if (held.has(e.keycode)) return; // ignore auto-repeat while a key is held
    held.add(e.keycode);
    if (!db.globalHotkeys || capturePaused) return;
    const base = names[e.keycode];
    if (!base || modifiers.has(base)) return;
    const combo = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', base].filter(Boolean).join('+');
    if (db.stopHotkey && combo === db.stopHotkey) { stopAll(); return; }
    if (db.randomHotkey && combo === db.randomHotkey) { playRandom().catch((err) => setError(err.message)); return; }
    const s = db.sounds.find((x) => x.hotkey === combo);
    if (s) play(s.id).catch((err) => setError(err.message));
  });
  uIOhook.on('keyup', (e) => held.delete(e.keycode));
  uIOhook.start();
  hook = uIOhook;
  process.on('exit', () => { try { uIOhook.stop(); } catch {} });
} catch (e) {
  hookError = e.message;
  console.error('In-game hotkeys unavailable:', e.message);
}

// Follow you between channels / leave when you leave
client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  changed();
  if (newS.id !== OWNER_ID || !db.followMe || !activeConnection()) return;
  try {
    if (!newS.channelId) leave();
    else if (oldS.channelId !== newS.channelId) await connectTo(newS.channel);
  } catch (e) { setError('Couldn\'t follow you: ' + e.message); }
});
[Events.GuildCreate, Events.GuildDelete, Events.ShardDisconnect, Events.ShardResume].forEach((ev) => client.on(ev, () => changed()));

client.once(Events.ClientReady, (c) => {
  console.log(`Bot online as ${c.user.tag}`);
  console.log(`Invite it to your server: ${inviteUrl()}`);
  changed();
});

const inviteUrl = () => client.user
  ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=3146752`
  : null;

// ---------- update check (GitHub releases) ----------
let update = null;
const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};
async function checkForUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'SoundBat', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return;
    const j = await r.json();
    const mine = electron?.app && newer(electron.app.getVersion(), CODE_VERSION) ? electron.app.getVersion() : CODE_VERSION;
    update = j.tag_name && newer(j.tag_name, mine) ? { version: j.tag_name.replace(/^v/, ''), url: j.html_url } : null;
    changed();
  } catch { /* offline — try later */ }
}
if (process.env.SOUNDBAT_NO_UPDATE_CHECK !== 'true') {
  setTimeout(checkForUpdate, 8_000).unref();
  setInterval(checkForUpdate, 6 * 3600_000).unref();
}

// ---------- web panel + API ----------
const app = express();
app.disable('x-powered-by');
let localPort = null;

// Security: this panel controls your bot, so other websites and other devices can't use it.
//  - Only pages served from localhost can make changes (they send an X-SoundBat header, which
//    other sites can't add without CORS). Host must be localhost, which blocks DNS-rebinding tricks.
//  - Phones / Stream Deck use a secret key (from Settings → Phone) and can only play and stop.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REMOTE_OK = [
  ['GET', /^\/api\/(state|events)$/], ['GET', /^\/(files|avatar)\b/],
  ['POST', /^\/api\/(play\/[\w-]+|stop(\/[\w-]+)?|random|join|leave)$/],
  ['GET', /^\/api\/(play\/[\w-]+|stop|random)$/], // for Stream Deck "website" buttons
];
const keyOk = (k) => {
  if (!k || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(config.remoteKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
app.use((req, res, next) => {
  const local = LOOPBACK.has(req.socket.remoteAddress) && req.socket.localPort === localPort;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const key = req.query.k || req.get('x-soundbat-key') || readCookie(req, 'sbk');
  const keyed = keyOk(key);
  req.remote = !local;
  if (local && !LOCAL_HOSTS.has(host)) return res.status(403).send('Open SoundBat at http://localhost');
  if (!local) {
    if (!db.phoneRemote || !keyed) return res.status(403).send('Phone remote is off, or this link is out of date. Scan the code in SoundBat → Settings → Phone again.');
  }
  // First visit from the phone link: remember the key in a cookie and tidy the URL
  if (req.method === 'GET' && req.path === '/' && req.query.k && keyed) {
    res.setHeader('Set-Cookie', `sbk=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return res.redirect('/');
  }
  const isApi = req.path.startsWith('/api/');
  if (!local || (keyed && req.get('x-soundbat') !== '1' && isApi)) {
    // key holders (phone / Stream Deck) get play + stop only
    if (isApi || req.path.startsWith('/files') || req.path === '/avatar') {
      if (!REMOTE_OK.some(([m, re]) => m === req.method && re.test(req.path))) return res.status(403).json({ error: 'Only the SoundBat app on your PC can change that' });
    }
    return next();
  }
  if (isApi && req.method !== 'GET' && req.get('x-soundbat') !== '1') return res.status(403).json({ error: 'Blocked a request that did not come from SoundBat' });
  if (isApi && req.method === 'GET' && /^\/api\/(play|stop|random)/.test(req.path)) return res.status(405).json({ error: 'Use POST' });
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(SOUND_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: SOUND_DIR,
    filename: (_req, file, cb) => cb(null, newId() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => cb(null, AUDIO_EXT.includes(path.extname(file.originalname).toLowerCase())),
});

const wrap = (fn) => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// ---------- live state (Server-Sent Events, with /api/state for a one-off read) ----------
function lanUrls(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .sort((a, b) => Number(/^(192\.168|10\.|172\.)/.test(b.address)) - Number(/^(192\.168|10\.|172\.)/.test(a.address)))
    .map((i) => `http://${i.address}:${port}/?k=${encodeURIComponent(config.remoteKey)}`);
}
function buildState(remote) {
  const conn = activeConnection();
  const vch = conn && client.channels.cache.get(conn.joinConfig.channelId);
  const och = client.isReady() ? ownerChannel() : null;
  const ids = playingIds();
  const s = {
    version: CODE_VERSION,
    remote,
    sounds: db.sounds.map(({ id, name, file, volume, hotkey, color, board, trimStart, trimEnd, loop, toggle, duration, long, broken }) =>
      ({ id, name, file, volume, hotkey, color, board, trimStart, trimEnd, loop, toggle, duration, long, broken: broken || null })),
    boards: db.boards,
    masterVolume: db.masterVolume,
    followMe: db.followMe,
    overlap: db.overlap,
    autoLevel: db.autoLevel,
    idleLeave: db.idleLeave,
    closeToTray: db.closeToTray,
    openAtLogin: db.openAtLogin,
    playing: ids[ids.length - 1] ?? null,
    playingIds: ids,
    progress: progress(),
    bot: { online: client.isReady(), tag: client.user?.tag ?? null, inviteUrl: inviteUrl(), servers: client.isReady() ? client.guilds.cache.size : 0 },
    hasToken: !!config.token,
    voice: vch ? { channel: vch.name, guild: vch.guild.name, status: conn.state.status } : null,
    you: och ? { channel: och.name, guild: och.guild.name } : null,
    lastError,
    needsSetup: !config.token || !config.ownerId || !config.profile,
    ownerId: config.ownerId,
    globalHotkeys: { enabled: db.globalHotkeys, active: !!hook, error: hookError, keys: hookKeyNames },
    stopHotkey: db.stopHotkey,
    randomHotkey: db.randomHotkey,
    theme: db.theme,
    ownerName: ownerName(),
    owner: ownerInfo(),
    profile: config.profile,
    update,
  };
  if (!remote) s.phone = { enabled: !!db.phoneRemote, port: lanPort, urls: lanServer ? lanUrls(lanPort) : [], error: lanError, key: config.remoteKey, localPort };
  if (remote) { s.needsSetup = false; delete s.ownerId; }
  return s;
}
app.get('/api/state', (req, res) => res.json(buildState(req.remote)));

const streams = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const c = { res, remote: req.remote, last: '' };
  streams.add(c);
  sendState(c, true);
  req.on('close', () => streams.delete(c));
});
function sendState(c, force) {
  const json = JSON.stringify(buildState(c.remote));
  if (!force && json === c.last) return;
  c.last = json;
  c.res.write(`data: ${json}\n\n`);
}
let changeTimer = null;
function changed() {
  if (changeTimer) return;
  changeTimer = setTimeout(() => { changeTimer = null; streams.forEach((c) => { try { sendState(c); } catch {} }); }, 40);
}
// While something plays, keep progress bars moving; otherwise just catch anything missed
setInterval(() => { if (mixing() || streams.size) changed(); }, 250).unref();
setInterval(() => streams.forEach((c) => { try { c.res.write(': ping\n\n'); } catch {} }), 20_000).unref();

// ---------- sounds ----------
async function addFiles(files, board) {
  const added = [], failed = [];
  for (const f of files) {
    const s = tidySound({ id: path.parse(f.filename).name, name: path.parse(f.originalname).name.slice(0, 40) || 'Sound', file: f.filename, volume: 1, board });
    db.sounds.push(s);
    await analyzeSound(s);
    if (s.broken) {
      db.sounds.splice(db.sounds.indexOf(s), 1);
      fs.rm(path.join(SOUND_DIR, s.file), () => {}); fs.rm(pcmFile(s), () => {});
      failed.push(f.originalname);
    } else added.push(s);
  }
  save(); changed();
  return { added, failed };
}

app.post('/api/sounds', upload.array('files', 50), wrap(async (req) => {
  if (!req.files?.length) throw new Error('No supported audio files (mp3, wav, ogg, m4a, webm, flac, aac, opus)');
  const r = await addFiles(req.files, req.body?.board);
  if (!r.added.length) throw new Error(`Couldn't read ${r.failed.join(', ')} as audio`);
  return r;
}));

// Add a sound from a link: a direct audio file, or a page with one on it (e.g. a sound-button site)
async function fetchCapped(url, max) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 SoundBat' } });
  if (!r.ok) throw new Error(`That link answered ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > max) throw new Error('That file is too big — sounds can be up to 25 MB');
  const chunks = []; let got = 0;
  for await (const c of r.body) { got += c.length; if (got > max) throw new Error('That file is too big — sounds can be up to 25 MB'); chunks.push(c); }
  return { buf: Buffer.concat(chunks), type: r.headers.get('content-type') || '', url: r.url };
}
function audioExtFrom(url, type) {
  const e = path.extname(new URL(url).pathname).toLowerCase();
  if (AUDIO_EXT.includes(e)) return e;
  const t = type.toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  if (t.includes('webm')) return '.webm';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return '.m4a';
  if (t.includes('flac')) return '.flac';
  if (t.includes('opus')) return '.opus';
  return null;
}
app.post('/api/sounds/url', wrap(async (req) => {
  let url;
  try { url = new URL(String(req.body.url || '').trim()); } catch { throw new Error('Paste a full link starting with https://'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) links work');
  const MAX = 25 * 1024 * 1024;
  let got = await fetchCapped(url.href, MAX);
  let name = decodeURIComponent(path.parse(new URL(got.url).pathname).name || 'Sound');
  if (/text\/html/i.test(got.type)) {
    const html = got.buf.toString('utf8');
    const title = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1];
    if (title) name = title.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').split(/\s[|–-]\s|\s-\sInstant/)[0].trim();
    const m = html.match(/["'(]((?:https?:)?\/\/[^"'()\s<>]+?\.(?:mp3|ogg|wav|m4a|opus)(?:\?[^"'()\s<>]*)?|\/[^"'()\s<>]+?\.(?:mp3|ogg|wav|m4a|opus))["')]/i);
    if (!m) throw new Error("Couldn't find a sound on that page — try a direct link to the audio file");
    got = await fetchCapped(new URL(m[1], got.url).href, MAX);
  }
  const ext = audioExtFrom(got.url, got.type);
  if (!ext) throw new Error("That link isn't an audio file");
  const id = newId();
  fs.writeFileSync(path.join(SOUND_DIR, id + ext), got.buf);
  const r = await addFiles([{ filename: id + ext, originalname: name.slice(0, 40) + ext }], req.body.board);
  if (!r.added.length) throw new Error("That link isn't a playable sound");
  return r;
}));

app.patch('/api/sounds/:id', wrap((req) => {
  const s = db.sounds.find((x) => x.id === req.params.id);
  if (!s) throw new Error('Sound not found');
  const { name, volume, hotkey, color, board, trimStart, trimEnd, loop, toggle } = req.body;
  if (name !== undefined) s.name = String(name).trim().slice(0, 40) || s.name;
  if (volume !== undefined) s.volume = clamp(volume, 0, 2);
  if (hotkey !== undefined) {
    const k = hotkey ? String(hotkey).slice(0, 40) : null;
    if (k) db.sounds.forEach((o) => { if (o.hotkey === k) o.hotkey = null; }); // one key = one sound
    if (k && k === db.stopHotkey) db.stopHotkey = null;
    if (k && k === db.randomHotkey) db.randomHotkey = null;
    s.hotkey = k;
  }
  if (color !== undefined) s.color = HEX.test(color || '') ? color : null;
  if (board !== undefined && db.boards.includes(board)) s.board = board;
  if (trimStart !== undefined) s.trimStart = Math.max(0, Number(trimStart) || 0);
  if (trimEnd !== undefined) s.trimEnd = trimEnd === null || trimEnd === '' ? null : Math.max(0, Number(trimEnd) || 0);
  if (s.duration && s.trimEnd != null && s.trimEnd >= s.duration - 0.01) s.trimEnd = null;
  if (s.trimEnd != null && s.trimEnd <= s.trimStart + 0.05) throw new Error('The end of the sound has to come after the start');
  if (s.duration && s.trimStart >= s.duration) throw new Error('The start is past the end of the sound');
  if (loop !== undefined) s.loop = !!loop;
  if (toggle !== undefined) s.toggle = !!toggle;
  save(); changed();
  return s;
}));

app.delete('/api/sounds/:id', wrap((req) => {
  const i = db.sounds.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw new Error('Sound not found');
  const [s] = db.sounds.splice(i, 1);
  stopSound(s.id);
  fs.rm(path.join(SOUND_DIR, s.file), () => {});
  fs.rm(pcmFile(s), () => {});
  pcmCache.drop(s.id + ':' + s.file);
  save(); changed();
}));

app.post('/api/sounds/reorder', wrap((req) => {
  const order = Array.isArray(req.body.ids) ? req.body.ids : [];
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; }; // unknown ones keep their place at the end
  db.sounds = db.sounds.map((s, i) => [s, i]).sort((a, b) => (rank(a[0].id) - rank(b[0].id)) || (a[1] - b[1])).map(([s]) => s);
  save(); changed();
}));

app.get('/api/sounds/:id/wave', wrap((req) => {
  const s = db.sounds.find((x) => x.id === req.params.id);
  if (!s) throw new Error('Sound not found');
  const key = s.id + ':' + s.file;
  if (!waveCache.has(key)) {
    const pcm = !s.long && loadPcm(s);
    if (!pcm) return { peaks: null, duration: s.duration ?? null };
    waveCache.set(key, audio.waveform(pcm, 480));
  }
  return { peaks: waveCache.get(key), duration: s.duration ?? null };
}));

// ---------- boards (pages of pads) ----------
const boardName = (n) => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 24);
app.post('/api/boards', wrap((req) => {
  const name = boardName(req.body.name);
  if (!name) throw new Error('Give the board a name');
  if (db.boards.some((b) => b.toLowerCase() === name.toLowerCase())) throw new Error('You already have a board called that');
  if (db.boards.length >= 24) throw new Error('That\'s a lot of boards! Delete one first');
  db.boards.push(name); save(); changed();
  return { boards: db.boards };
}));
app.patch('/api/boards', wrap((req) => {
  const from = String(req.body.from || ''), to = boardName(req.body.to);
  const i = db.boards.indexOf(from);
  if (i < 0) throw new Error('Board not found');
  if (!to) throw new Error('Give the board a name');
  if (db.boards.some((b, j) => j !== i && b.toLowerCase() === to.toLowerCase())) throw new Error('You already have a board called that');
  db.boards[i] = to;
  db.sounds.forEach((s) => { if (s.board === from) s.board = to; });
  save(); changed();
  return { boards: db.boards };
}));
app.delete('/api/boards/:name', wrap((req) => {
  const i = db.boards.indexOf(req.params.name);
  if (i < 0) throw new Error('Board not found');
  if (db.boards.length === 1) throw new Error('You need at least one board');
  db.boards.splice(i, 1);
  db.sounds.forEach((s) => { if (s.board === req.params.name) s.board = db.boards[0]; }); // sounds move, never vanish
  save(); changed();
  return { boards: db.boards };
}));

// ---------- setup / account ----------
app.post('/api/config', wrap(async (req) => {
  const token = String(req.body.token || '').trim().replace(/^Bot\s+/i, '');
  const ownerId = String(req.body.ownerId || '').trim();
  if (ownerId && !/^\d{15,22}$/.test(ownerId)) throw new Error('User ID should be a long number like 441563277697220631');
  if (token) {
    if (token.split('.').length !== 3) throw new Error("That doesn't look like a bot token — copy it again from the Bot tab");
    const old = config.token;
    config.token = token;
    if (token !== old || !client.isReady()) {
      try { await login(); await waitReady(15000); }
      catch (e) { config.token = old; if (old) login().catch(() => {}); throw new Error('Discord rejected that token — hit Reset Token and copy the new one'); }
    }
  }
  if (!config.token) throw new Error('Paste your bot token');
  if (ownerId) config.ownerId = OWNER_ID = ownerId;
  saveConfig(); changed();
}));

// First-run helper: people currently in voice channels the bot can see, so you can pick yourself
app.get('/api/voice-members', (_req, res) => {
  const people = [];
  if (client.isReady()) {
    for (const guild of client.guilds.cache.values()) {
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || vs.member?.user?.bot) continue;
        const user = vs.member?.user;
        people.push({
          id: vs.id,
          name: vs.member?.displayName || user?.globalName || user?.username || 'Unknown',
          avatar: vs.member?.displayAvatarURL?.({ size: 64 }) || null,
          channel: vs.channel?.name || '',
          guild: guild.name,
        });
      }
    }
  }
  res.json({ people });
});

// SoundBat profile (stored on this PC only)
const AVATAR_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
app.get('/avatar', (_req, res) => {
  const f = config.profile?.avatarFile && path.join(DATA_DIR, path.basename(config.profile.avatarFile));
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'no-store').sendFile(f);
});
app.post('/api/profile', wrap((req) => {
  const name = String(req.body.name ?? config.profile?.name ?? '').trim().slice(0, 24);
  if (!name) throw new Error('Pick a name');
  const color = HEX.test(req.body.color || '') ? req.body.color : (config.profile?.color || '#8b5cff');
  const useDiscord = req.body.useDiscordAvatar !== undefined ? !!req.body.useDiscordAvatar : !!config.profile?.useDiscordAvatar;
  config.profile = { ...(config.profile || {}), name, color, useDiscordAvatar: useDiscord };
  if (req.body.clearPhoto && config.profile.avatarFile) {
    fs.rm(path.join(DATA_DIR, config.profile.avatarFile), () => {});
    delete config.profile.avatarFile;
  }
  saveConfig(); changed();
  return config.profile;
}));
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: DATA_DIR,
    filename: (_req, file, cb) => cb(null, 'avatar' + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, AVATAR_EXT.includes(path.extname(file.originalname).toLowerCase())),
});
app.post('/api/profile/photo', avatarUpload.single('photo'), wrap((req) => {
  if (!req.file) throw new Error('Use a PNG, JPG, GIF or WEBP image under 5 MB');
  const old = config.profile?.avatarFile;
  if (old && old !== req.file.filename) fs.rm(path.join(DATA_DIR, old), () => {});
  config.profile = { ...(config.profile || { name: 'Bat', color: '#8b5cff' }), avatarFile: req.file.filename, useDiscordAvatar: false };
  saveConfig(); changed();
  return config.profile;
}));

// Log out: disconnect the bot and forget the account on this PC (sounds kept unless asked)
app.post('/api/logout', wrap(async (req) => {
  stopAll();
  leave();
  try { await client.destroy(); } catch {}
  if (config.profile?.avatarFile) fs.rm(path.join(DATA_DIR, config.profile.avatarFile), () => {});
  config = { token: null, ownerId: null, profile: null, remoteKey: crypto.randomBytes(18).toString('base64url') };
  OWNER_ID = null;
  saveConfig();
  if (req.body?.wipeSounds) {
    db.sounds.forEach((snd) => { fs.rm(path.join(SOUND_DIR, snd.file), () => {}); fs.rm(pcmFile(snd), () => {}); });
    db.sounds = []; db.theme = null; db.stopHotkey = null; db.randomHotkey = null; db.boards = ['Main'];
    save();
  }
  changed();
}));

// Switch which Discord person the bat follows
app.post('/api/owner', wrap((req) => {
  const id = String(req.body.ownerId || '').trim();
  if (!/^\d{15,22}$/.test(id)) throw new Error('Pick someone from the list');
  config.ownerId = OWNER_ID = id;
  saveConfig(); changed();
}));

// Pause in-game hotkeys while the panel is waiting for you to press a new key
app.post('/api/capture', wrap((req) => {
  capturePaused = !!req.body.on;
  clearTimeout(captureTimer);
  if (capturePaused) captureTimer = setTimeout(() => { capturePaused = false; }, 20_000);
}));

// ---------- playback API (also used by the phone remote and Stream Deck links) ----------
const playRoute = wrap((req) => play(req.params.id));
app.post('/api/play/:id', playRoute);
app.get('/api/play/:id', playRoute);
const stopRoute = wrap(() => stopAll());
app.post('/api/stop', stopRoute);
app.get('/api/stop', stopRoute);
app.post('/api/stop/:id', wrap((req) => stopSound(req.params.id)));
const randomRoute = wrap((req) => playRandom(Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : null));
app.post('/api/random', randomRoute);
app.get('/api/random', randomRoute);
app.post('/api/join', wrap(async () => { await joinOwner(); changed(); }));
app.post('/api/leave', wrap(() => leave()));

app.patch('/api/settings', wrap((req) => {
  const b = req.body;
  if (b.theme !== undefined) db.theme = b.theme && HEX.test(b.theme.a) && HEX.test(b.theme.b) ? { a: b.theme.a, b: b.theme.b } : null;
  if (b.masterVolume !== undefined) db.masterVolume = clamp(b.masterVolume, 0, 1.5);
  ['followMe', 'globalHotkeys', 'overlap', 'autoLevel', 'closeToTray', 'openAtLogin'].forEach((k) => { if (b[k] !== undefined) db[k] = !!b[k]; });
  if (b.idleLeave !== undefined) db.idleLeave = [0, 5, 15, 30, 60].includes(+b.idleLeave) ? +b.idleLeave : 0;
  for (const k of ['stopHotkey', 'randomHotkey']) {
    if (b[k] === undefined) continue;
    db[k] = b[k] ? String(b[k]).slice(0, 40) : null;
    if (db[k]) {
      db.sounds.forEach((o) => { if (o.hotkey === db[k]) o.hotkey = null; });
      const other = k === 'stopHotkey' ? 'randomHotkey' : 'stopHotkey';
      if (db[other] === db[k]) db[other] = null;
    }
  }
  if (b.phoneRemote !== undefined) { db.phoneRemote = !!b.phoneRemote; setPhoneRemote(db.phoneRemote); }
  save(); changed();
  events.emit('settings', db);
}));

// New phone link (old QR codes and Stream Deck links stop working)
app.post('/api/phone/reset', wrap(() => { config.remoteKey = crypto.randomBytes(18).toString('base64url'); saveConfig(); changed(); }));

// Desktop app: open the folder your sounds live in
app.post('/api/open-folder', wrap(async () => {
  if (!electron?.shell) throw new Error('Only available in the desktop app');
  const err = await electron.shell.openPath(SOUND_DIR);
  if (err) throw new Error(err);
}));

// Friendly errors (e.g. a file over 25 MB) instead of an HTML error page
app.use((err, _req, res, _next) => {
  const msg = err?.code === 'LIMIT_FILE_SIZE' ? 'That file is too big — sounds can be up to 25 MB'
    : err?.code === 'LIMIT_FILE_COUNT' ? 'Add up to 50 files at a time'
    : err?.type === 'entity.parse.failed' ? 'Bad request' : (err?.message || 'Something went wrong');
  res.status(err?.status && err.status < 500 ? err.status : 400).json({ error: msg });
});

function waitReady(ms) {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    client.once(Events.ClientReady, () => { clearTimeout(t); resolve(); });
  });
}

async function login() {
  if (client.isReady() || client.token) await client.destroy();
  lastError = null;
  try { await client.login(config.token); }
  catch (e) {
    console.error('Discord login failed:', e.message);
    setError('Discord login failed — check your bot token');
    throw new Error(lastError.msg);
  } finally { changed(); }
}

// ---------- phone remote (a second listener on your Wi-Fi, only while it's switched on) ----------
let lanServer = null, lanPort = null, lanError = null;
function setPhoneRemote(on) {
  if (!on) { lanServer?.close(); lanServer = null; lanPort = null; lanError = null; changed(); return; }
  if (lanServer) return;
  const srv = http.createServer(app);
  const tryListen = (port) => srv.listen(port, '0.0.0.0');
  srv.on('listening', () => { lanServer = srv; lanPort = srv.address().port; lanError = null; changed();
    lanUrls(lanPort).forEach((u) => console.log(`  phone remote:    ${u}`)); });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !srv.__retried) { srv.__retried = true; return tryListen(0); }
    lanError = e.message; changed();
  });
  tryListen(PORT + 1);
}

// Starts the panel server; resolves with the port it's on (falls back to a free port if taken)
module.exports.ready = new Promise((resolve, reject) => {
  const onListen = (srv) => {
    localPort = srv.address().port;
    console.log(`Soundboard panel: http://localhost:${localPort}`);
    if (db.phoneRemote) setPhoneRemote(true);
    resolve(localPort);
  };
  const srv = app.listen(PORT, '127.0.0.1', () => onListen(srv));
  srv.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') return reject(e);
    const alt = app.listen(0, '127.0.0.1', () => onListen(alt));
    alt.on('error', reject);
  });
});
module.exports.events = events;
module.exports.settings = () => db;
module.exports.stopAll = stopAll;
module.exports.version = CODE_VERSION;

// Measure any sounds we haven't yet (older boards, starter pack), a few at a time in the background
setTimeout(() => db.sounds.filter(needsAnalysis).forEach(analyzeSound), 1500).unref();
if (config.token) login().catch(() => {});
