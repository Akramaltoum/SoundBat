// Discord Soundboard — a bot that joins your voice call and plays sounds you trigger
// from a Stream Deck-style web panel (http://localhost:3000).

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Bundled ffmpeg (no install scripts needed) — put it on PATH so the voice library finds it
// (inside the packaged app the binary lives in app.asar.unpacked)
try {
  const FFMPEG_DIR = path.dirname(require('@ffmpeg-installer/ffmpeg').path.replace('app.asar', 'app.asar.unpacked'));
  process.env.PATH = FFMPEG_DIR + path.delimiter + process.env.PATH;
} catch (e) { console.error('Bundled ffmpeg not found, falling back to system ffmpeg:', String(e.message || e)); }
const express = require('express');
const multer = require('multer');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, entersState,
} = require('@discordjs/voice');

// ---------- storage + config ----------
// Desktop app: data lives in the user's app-data folder. Script mode: next to this file.
const DATA_DIR = process.env.SOUNDBOARD_DATA || __dirname;
const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const DB_FILE = path.join(DATA_DIR, 'sounds.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const validEnv = (v) => v && !v.startsWith('paste_') ? v : null;
let config = { token: null, ownerId: null, profile: null };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* first run */ }
config.token = validEnv(process.env.DISCORD_TOKEN) || config.token;
config.ownerId = validEnv(process.env.OWNER_ID) || config.ownerId;
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token: config.token, ownerId: config.ownerId, profile: config.profile }, null, 2));
let OWNER_ID = config.ownerId;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.ALLOW_LAN === 'true' ? '0.0.0.0' : '127.0.0.1';

const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac', '.aac', '.opus'];
fs.mkdirSync(SOUND_DIR, { recursive: true });

let db = { masterVolume: 0.8, followMe: true, globalHotkeys: true, stopHotkey: null, theme: null, sounds: [] };
let firstRun = !fs.existsSync(DB_FILE);
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }

// First run: start with a small pack of original SoundBat sounds so the board isn't empty
if (firstRun) {
  const STARTER = path.join(__dirname, 'starter');
  const order = ['Air Horn', 'Ba Dum Tss', 'Bat Screech', 'Victory', 'Sad Trombone', 'Drumroll', 'Boing', 'Whoosh'];
  try {
    order.forEach((name) => {
      const src = path.join(STARTER, name + '.mp3');
      if (!fs.existsSync(src)) return;
      const id = crypto.randomUUID().slice(0, 8);
      fs.copyFileSync(src, path.join(SOUND_DIR, id + '.mp3'));
      db.sounds.push({ id, name, file: id + '.mp3', volume: 1, hotkey: null, color: null });
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('Starter pack failed:', e.message); }
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));

// ---------- discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let current = null; // { id, resource }
let lastError = null;

player.on('error', (e) => { console.error('Playback error:', e.message); lastError = e.message; });
player.on(AudioPlayerStatus.Idle, () => { current = null; });

function ownerChannel() {
  for (const guild of client.guilds.cache.values()) {
    const vs = guild.voiceStates.cache.get(OWNER_ID);
    if (vs?.channel) return vs.channel;
  }
  return null;
}

function ownerName() {
  if (!OWNER_ID || !client.isReady()) return null;
  for (const guild of client.guilds.cache.values()) {
    const m = guild.members.cache.get(OWNER_ID) || guild.voiceStates.cache.get(OWNER_ID)?.member;
    if (m) return m.displayName || m.user?.globalName || m.user?.username;
  }
  return client.users.cache.get(OWNER_ID)?.globalName || client.users.cache.get(OWNER_ID)?.username || null;
}

function ownerInfo() {
  if (!OWNER_ID) return null;
  let avatar = null;
  if (client.isReady()) {
    for (const guild of client.guilds.cache.values()) {
      const m = guild.members.cache.get(OWNER_ID) || guild.voiceStates.cache.get(OWNER_ID)?.member;
      if (m) { avatar = m.displayAvatarURL({ size: 128 }); break; }
    }
    if (!avatar) avatar = client.users.cache.get(OWNER_ID)?.displayAvatarURL({ size: 128 }) || null;
  }
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
}

async function connectTo(channel) {
  const existing = getVoiceConnection(channel.guild.id);
  if (existing && existing.joinConfig.channelId === channel.id &&
      existing.state.status !== VoiceConnectionStatus.Destroyed) {
    await entersState(existing, VoiceConnectionStatus.Ready, 15_000);
    return existing;
  }
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
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch { conn.destroy(); }
    });
  }
  await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  return conn;
}

async function joinOwner() {
  if (!client.isReady()) throw new Error('Bot is not online yet');
  const ch = ownerChannel();
  if (!ch) throw new Error("You're not in a voice channel the bot can see");
  return connectTo(ch);
}

async function play(id) {
  const sound = db.sounds.find((s) => s.id === id);
  if (!sound) throw new Error('Sound not found');
  await joinOwner();
  const resource = createAudioResource(path.join(SOUND_DIR, sound.file), { inlineVolume: true });
  resource.volume.setVolume(sound.volume * db.masterVolume);
  player.play(resource);
  current = { id, resource };
  lastError = null;
}

// ---------- in-game (system-wide) hotkeys ----------
// Names match the panel's key names: A-Z, 0-9, Num0-9, NumAdd, F1-F24, Space, ArrowUp, ... with Ctrl/Alt/Shift+ prefixes.
let hook = null, hookError = null, capturePaused = false, captureTimer = null;
try {
  if (process.env.DISABLE_GAME_HOTKEYS === 'true') throw new Error('turned off in .env');
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const numlockOff = { NumpadInsert: 'Num0', NumpadEnd: 'Num1', NumpadArrowDown: 'Num2', NumpadPageDown: 'Num3',
    NumpadArrowLeft: 'Num4', NumpadArrowRight: 'Num6', NumpadHome: 'Num7', NumpadArrowUp: 'Num8',
    NumpadPageUp: 'Num9', NumpadDelete: 'NumDecimal' };
  const modifiers = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight']);
  const names = {};
  for (const [k, code] of Object.entries(UiohookKey)) names[code] = numlockOff[k] || k.replace(/^Numpad/, 'Num');
  const held = new Set();

  uIOhook.on('keydown', (e) => {
    if (held.has(e.keycode)) return; // ignore auto-repeat while a key is held
    held.add(e.keycode);
    if (!db.globalHotkeys || capturePaused) return;
    const base = names[e.keycode];
    if (!base || modifiers.has(base)) return;
    const combo = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', base].filter(Boolean).join('+');
    if (db.stopHotkey && combo === db.stopHotkey) { player.stop(true); current = null; return; }
    const s = db.sounds.find((x) => x.hotkey === combo);
    if (s) play(s.id).catch((err) => { lastError = err.message; });
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
  if (newS.id !== OWNER_ID || !db.followMe || !activeConnection()) return;
  try {
    if (!newS.channelId) leave();
    else if (oldS.channelId !== newS.channelId) await connectTo(newS.channel);
  } catch (e) { console.error('Follow failed:', e.message); }
});

client.once(Events.ClientReady, (c) => {
  console.log(`Bot online as ${c.user.tag}`);
  console.log(`Invite it to your server: ${inviteUrl()}`);
});

const inviteUrl = () => client.user
  ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=3146752`
  : null;

// ---------- web panel + API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(SOUND_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: SOUND_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID().slice(0, 8) + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, AUDIO_EXT.includes(path.extname(file.originalname).toLowerCase())),
});

const wrap = (fn) => async (req, res) => {
  try { res.json((await fn(req)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/state', (_req, res) => {
  const conn = activeConnection();
  const vch = conn && client.channels.cache.get(conn.joinConfig.channelId);
  const och = client.isReady() ? ownerChannel() : null;
  res.json({
    sounds: db.sounds,
    masterVolume: db.masterVolume,
    followMe: db.followMe,
    playing: player.state.status === AudioPlayerStatus.Playing ? current?.id ?? null : null,
    bot: { online: client.isReady(), tag: client.user?.tag ?? null, inviteUrl: inviteUrl(), servers: client.isReady() ? client.guilds.cache.size : 0 },
    hasToken: !!config.token,
    voice: vch ? { channel: vch.name, guild: vch.guild.name, status: conn.state.status } : null,
    you: och ? { channel: och.name, guild: och.guild.name } : null,
    lastError,
    needsSetup: !config.token || !config.ownerId || !config.profile,
    ownerId: config.ownerId,
    globalHotkeys: { enabled: db.globalHotkeys, active: !!hook, error: hookError },
    stopHotkey: db.stopHotkey,
    theme: db.theme,
    ownerName: ownerName(),
    owner: ownerInfo(),
    profile: config.profile,
  });
});

app.post('/api/sounds', upload.array('files', 50), wrap((req) => {
  if (!req.files?.length) throw new Error('No supported audio files (mp3, wav, ogg, m4a, webm, flac, aac, opus)');
  const added = req.files.map((f) => ({
    id: path.parse(f.filename).name,
    name: path.parse(f.originalname).name.slice(0, 40),
    file: f.filename,
    volume: 1,
    hotkey: null,
    color: null,
  }));
  db.sounds.push(...added);
  save();
  return { added };
}));

app.patch('/api/sounds/:id', wrap((req) => {
  const s = db.sounds.find((x) => x.id === req.params.id);
  if (!s) throw new Error('Sound not found');
  const { name, volume, hotkey, color } = req.body;
  if (name !== undefined) s.name = String(name).slice(0, 40) || s.name;
  if (volume !== undefined) s.volume = clamp(volume, 0, 2);
  if (hotkey !== undefined) {
    if (hotkey) db.sounds.forEach((o) => { if (o.hotkey === hotkey) o.hotkey = null; }); // one key = one sound
    if (hotkey && hotkey === db.stopHotkey) db.stopHotkey = null;
    s.hotkey = hotkey || null;
  }
  if (color !== undefined) s.color = color || null;
  if (current?.id === s.id) current.resource.volume.setVolume(s.volume * db.masterVolume);
  save();
  return s;
}));

app.delete('/api/sounds/:id', wrap((req) => {
  const i = db.sounds.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw new Error('Sound not found');
  const [s] = db.sounds.splice(i, 1);
  if (current?.id === s.id) player.stop(true);
  fs.rm(path.join(SOUND_DIR, s.file), () => {});
  save();
}));

app.post('/api/sounds/reorder', wrap((req) => {
  const order = req.body.ids || [];
  db.sounds.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  save();
}));

// First-run setup / settings: bot token + your user ID
app.post('/api/config', wrap(async (req) => {
  const token = String(req.body.token || '').trim();
  const ownerId = String(req.body.ownerId || '').trim();
  if (ownerId && !/^\d{15,22}$/.test(ownerId)) throw new Error('User ID should be a long number like 441563277697220631');
  if (token) {
    if (token.split('.').length !== 3) throw new Error("That doesn't look like a bot token — copy it again from the Bot tab");
    const old = config.token;
    config.token = token;
    if (token !== old || !client.isReady()) {
      try { await login(); await waitReady(15000); }
      catch (e) { config.token = old; throw new Error('Discord rejected that token — hit Reset Token and copy the new one'); }
    }
  }
  if (!config.token) throw new Error('Paste your bot token');
  if (ownerId) config.ownerId = OWNER_ID = ownerId;
  saveConfig();
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

// ---------- SoundBat profile (stored on this PC only) ----------
const AVATAR_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
app.get('/avatar', (_req, res) => {
  const f = config.profile?.avatarFile && path.join(DATA_DIR, config.profile.avatarFile);
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'no-store').sendFile(f);
});
app.post('/api/profile', wrap((req) => {
  const name = String(req.body.name ?? config.profile?.name ?? '').trim().slice(0, 24);
  if (!name) throw new Error('Pick a name');
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : (config.profile?.color || '#8b5cff');
  const useDiscord = req.body.useDiscordAvatar !== undefined ? !!req.body.useDiscordAvatar : !!config.profile?.useDiscordAvatar;
  config.profile = { ...(config.profile || {}), name, color, useDiscordAvatar: useDiscord };
  if (req.body.clearPhoto && config.profile.avatarFile) {
    fs.rm(path.join(DATA_DIR, config.profile.avatarFile), () => {});
    delete config.profile.avatarFile;
  }
  saveConfig();
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
  saveConfig();
  return config.profile;
}));

// Log out: disconnect the bot and forget the account on this PC (sounds kept unless asked)
app.post('/api/logout', wrap(async (req) => {
  player.stop(true); current = null;
  leave();
  try { await client.destroy(); } catch {}
  if (config.profile?.avatarFile) fs.rm(path.join(DATA_DIR, config.profile.avatarFile), () => {});
  config = { token: null, ownerId: null, profile: null };
  OWNER_ID = null;
  saveConfig();
  if (req.body?.wipeSounds) {
    db.sounds.forEach((snd) => fs.rm(path.join(SOUND_DIR, snd.file), () => {}));
    db.sounds = []; db.theme = null; db.stopHotkey = null;
    save();
  }
}));

// Switch which Discord person the bat follows
app.post('/api/owner', wrap((req) => {
  const id = String(req.body.ownerId || '').trim();
  if (!/^\d{15,22}$/.test(id)) throw new Error('Pick someone from the list');
  config.ownerId = OWNER_ID = id;
  saveConfig();
}));

// Pause in-game hotkeys while the panel is waiting for you to press a new key
app.post('/api/capture', wrap((req) => {
  capturePaused = !!req.body.on;
  clearTimeout(captureTimer);
  if (capturePaused) captureTimer = setTimeout(() => { capturePaused = false; }, 20_000);
}));

app.post('/api/play/:id', wrap((req) => play(req.params.id)));
app.post('/api/stop', wrap(() => { player.stop(true); current = null; }));
app.post('/api/join', wrap(async () => { await joinOwner(); }));
app.post('/api/leave', wrap(() => leave()));

app.patch('/api/settings', wrap((req) => {
  const { masterVolume, followMe, globalHotkeys, stopHotkey, theme } = req.body;
  if (theme !== undefined) db.theme = theme && /^#[0-9a-f]{6}$/i.test(theme.a) && /^#[0-9a-f]{6}$/i.test(theme.b) ? { a: theme.a, b: theme.b } : null;
  if (masterVolume !== undefined) db.masterVolume = clamp(masterVolume, 0, 1.5);
  if (followMe !== undefined) db.followMe = !!followMe;
  if (globalHotkeys !== undefined) db.globalHotkeys = !!globalHotkeys;
  if (stopHotkey !== undefined) {
    db.stopHotkey = stopHotkey || null;
    if (db.stopHotkey) db.sounds.forEach((o) => { if (o.hotkey === db.stopHotkey) o.hotkey = null; });
  }
  if (current) {
    const s = db.sounds.find((x) => x.id === current.id);
    if (s) current.resource.volume.setVolume(s.volume * db.masterVolume);
  }
  save();
}));

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
    lastError = 'Discord login failed — check your bot token';
    throw new Error(lastError);
  }
}

// Starts the panel server; resolves with the port it's on (falls back to a free port if taken)
module.exports.ready = new Promise((resolve) => {
  const onListen = (srv) => {
    const port = srv.address().port;
    console.log(`Soundboard panel: http://localhost:${port}`);
    if (HOST === '0.0.0.0') {
      const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
      ips.forEach((i) => console.log(`  on your phone:   http://${i.address}:${port}`));
    }
    resolve(port);
  };
  const srv = app.listen(PORT, HOST, () => onListen(srv));
  srv.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    const alt = app.listen(0, HOST, () => onListen(alt));
  });
});

if (config.token) login().catch(() => {});
