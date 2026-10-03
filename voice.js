// Voice Lab: type anything, get an AI voice clip, save it to your board.
// The voice model (Kokoro-82M, Apache-2.0, ~90 MB) downloads once on first use and then runs
// entirely on this PC in a background thread. Effects are ffmpeg filters.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

const MODEL = {
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx',
  file: 'kokoro-v1.0.int8.onnx',
  size: 92361271,
  sha256: '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb',
};
const MAX_TEXT = 1000;
const KEEP_TAKES = 30;
const IDLE_MS = 10 * 60_000; // free the model's memory after 10 quiet minutes

// Display names for the bundled voices (US / UK English)
const VOICES = [
  ['af_heart', 'Heart', 'US', 'F'], ['af_bella', 'Bella', 'US', 'F'], ['af_nicole', 'Nicole (whispery)', 'US', 'F'],
  ['af_sarah', 'Sarah', 'US', 'F'], ['af_kore', 'Kore', 'US', 'F'], ['af_aoede', 'Aoede', 'US', 'F'], ['af_nova', 'Nova', 'US', 'F'],
  ['af_sky', 'Sky', 'US', 'F'], ['af_alloy', 'Alloy', 'US', 'F'], ['af_jessica', 'Jessica', 'US', 'F'], ['af_river', 'River', 'US', 'F'],
  ['am_michael', 'Michael', 'US', 'M'], ['am_fenrir', 'Fenrir', 'US', 'M'], ['am_puck', 'Puck', 'US', 'M'], ['am_onyx', 'Onyx (deep)', 'US', 'M'],
  ['am_echo', 'Echo', 'US', 'M'], ['am_eric', 'Eric', 'US', 'M'], ['am_liam', 'Liam', 'US', 'M'], ['am_adam', 'Adam', 'US', 'M'],
  ['am_santa', 'Santa', 'US', 'M'],
  ['bf_emma', 'Emma', 'UK', 'F'], ['bf_isabella', 'Isabella', 'UK', 'F'], ['bf_alice', 'Alice', 'UK', 'F'], ['bf_lily', 'Lily', 'UK', 'F'],
  ['bm_george', 'George', 'UK', 'M'], ['bm_fable', 'Fable', 'UK', 'M'], ['bm_lewis', 'Lewis', 'UK', 'M'], ['bm_daniel', 'Daniel', 'UK', 'M'],
].map(([id, name, accent, gender]) => ({ id, name, accent, gender }));
const VOICE_IDS = new Set(VOICES.map((v) => v.id));

// ffmpeg filter chains (only filters in ffmpeg 4.1+, the version bundled with the app). Input is 24 kHz mono.
const pitch = (f) => `asetrate=${Math.round(24000 * f)},aresample=24000,atempo=${(1 / f).toFixed(4)}`;
const EFFECTS = [
  { id: 'none', name: 'Clean', f: '' },
  { id: 'hype', name: 'Hype', f: 'acompressor=threshold=0.1:ratio=6:makeup=3,volume=1.4' },
  { id: 'deep', name: 'Deep', f: pitch(0.8) },
  { id: 'demon', name: 'Demon', f: `${pitch(0.62)},aecho=0.8:0.6:35:0.45,volume=1.6` },
  { id: 'chipmunk', name: 'Chipmunk', f: pitch(1.55) },
  { id: 'robot', name: 'Robot', f: "aresample=192000,afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':overlap=0.75,aresample=24000,volume=1.3" },
  { id: 'radio', name: 'Walkie-talkie', f: 'highpass=f=450,lowpass=f=2800,acrusher=bits=8:mix=0.35:mode=log,volume=2' },
  { id: 'phone', name: 'Phone call', f: 'highpass=f=300,lowpass=f=3400,volume=1.5' },
  { id: 'megaphone', name: 'Megaphone', f: 'highpass=f=650,lowpass=f=4200,volume=3,acrusher=level_in=2:bits=7:mix=0.5:mode=log' },
  { id: 'stadium', name: 'Stadium', f: `${pitch(0.93)},apad=pad_len=30000,aecho=0.8:0.85:190|380:0.35|0.2` },
  { id: 'echo', name: 'Cave echo', f: 'apad=pad_len=36000,aecho=0.8:0.9:450|900:0.45|0.25' },
  { id: 'underwater', name: 'Underwater', f: 'lowpass=f=420,vibrato=f=5:d=0.35,volume=2' },
  { id: 'alien', name: 'Alien', f: `${pitch(1.22)},vibrato=f=9:d=0.6,aecho=0.8:0.6:22:0.35` },
  { id: 'ghost', name: 'Ghost', f: `${pitch(0.9)},apad=pad_len=24000,aecho=0.8:0.88:70|190|420:0.4|0.3|0.2,tremolo=f=6:d=0.35` },
  { id: 'slowmo', name: 'Slow-mo', f: 'asetrate=16800,aresample=24000' },
  { id: 'fast', name: 'Fast-forward', f: 'asetrate=34800,aresample=24000' },
  { id: 'reverse', name: 'Backwards', f: 'areverse' },
  { id: 'blown', name: 'Blown out', f: 'volume=6,acrusher=level_in=4:level_out=0.6:bits=5:mix=0.6:mode=log,lowpass=f=6000' },
];
const EFFECT_BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

function create({ dataDir, codeDir, ffmpeg, soundPath }) {
  const MODEL_DIR = path.join(dataDir, 'models');
  const TAKE_DIR = path.join(dataDir, 'cache', 'voicelab');
  const modelFile = path.join(MODEL_DIR, MODEL.file);
  // Packaged app: the worker and its libraries live outside app.asar so worker threads can load them
  const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const voiceDir = unpacked(path.join(codeDir, 'voices'));
  const workerFile = unpacked(path.join(codeDir, 'voice-worker.js'));
  [MODEL_DIR, TAKE_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  for (const f of fs.readdirSync(TAKE_DIR)) fs.rm(path.join(TAKE_DIR, f), { force: true }, () => {}); // takes don't outlive a restart

  const events = new EventEmitter();
  const engine = { state: fs.existsSync(modelFile) ? 'ready' : 'missing', progress: 0, error: null };
  const setEngine = (patch) => { Object.assign(engine, patch); events.emit('change'); };
  const takes = new Map(); // id -> { id, file, text, voice, effect, duration, created }

  // ---------- one-time model download ----------
  let downloading = null;
  function download() {
    if (engine.state === 'ready') return Promise.resolve();
    if (downloading) return downloading;
    setEngine({ state: 'downloading', progress: 0, error: null });
    downloading = (async () => {
      const part = modelFile + '.part';
      try {
        const r = await fetch(MODEL.url, { redirect: 'follow', headers: { 'User-Agent': 'SoundBat' } });
        if (!r.ok) throw new Error(`the download server answered ${r.status}`);
        const out = fs.createWriteStream(part);
        const hash = crypto.createHash('sha256');
        let got = 0, lastEmit = 0;
        for await (const chunk of r.body) {
          got += chunk.length; hash.update(chunk);
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
          if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); setEngine({ progress: Math.min(0.99, got / MODEL.size) }); }
        }
        await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
        if (hash.digest('hex') !== MODEL.sha256) throw new Error('the download was damaged — try again');
        fs.renameSync(part, modelFile);
        setEngine({ state: 'ready', progress: 1 });
      } catch (e) {
        fs.rm(part, { force: true }, () => {});
        setEngine({ state: 'error', error: "Couldn't download the voice engine: " + (e.message || e) + '. Check your internet and try again.' });
        throw new Error(engine.error);
      } finally { downloading = null; }
    })();
    return downloading;
  }

  // ---------- background worker ----------
  let worker = null, loaded = null, seq = 0, idleTimer = null;
  const pending = new Map();
  function stopWorker() { if (worker) { worker.terminate().catch(() => {}); worker = null; loaded = null; } }
  function startWorker() {
    worker = new Worker(workerFile, { workerData: { voiceDir } });
    worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error)); });
    const fail = (e) => { pending.forEach((p) => p.reject(new Error('The voice engine stopped: ' + (e?.message || e)))); pending.clear(); worker = null; loaded = null; };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (code) fail(new Error('exit ' + code)); worker = null; loaded = null; });
  }
  function call(msg) {
    if (!worker) startWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  }
  async function ensureLoaded() {
    if (engine.state !== 'ready') {
      if (engine.state === 'downloading') throw new Error('The voice engine is still downloading — hang tight');
      throw new Error('Download the voice engine first');
    }
    if (!loaded) loaded = call({ type: 'load', modelFile }).catch((e) => { loaded = null; throw e; });
    await loaded;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopWorker, IDLE_MS); idleTimer.unref?.();
  }

  // ---------- ffmpeg: speech + pitch + effect (+ optional sounds before/after) -> mp3 ----------
  function render({ pcm, semitones, effect, before, after, out }) {
    const chain = [];
    if (semitones) chain.push(pitch(Math.pow(2, semitones / 12)));
    if (effect.f) chain.push(effect.f);
    chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0'];
    const stings = [before, after].filter(Boolean);
    stings.forEach((s) => args.push('-i', s.file));
    // Each piece is loudness-matched so an air horn doesn't drown out the voice
    const norm = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    let graph = `[0:a]${chain.join(',')}${stings.length ? ',' + norm : ''}[v]`;
    const trim = (s) => (s.trimStart || s.trimEnd != null ? `atrim=start=${+s.trimStart || 0}${s.trimEnd != null ? ':end=' + s.trimEnd : ''},asetpts=PTS-STARTPTS,` : '');
    const order = [];
    if (before) { graph += `;[1:a]${trim(before)}${norm}[b]`; order.push('[b]'); }
    order.push('[v]');
    if (after) { graph += `;[${before ? 2 : 1}:a]${trim(after)}${norm}[c]`; order.push('[c]'); }
    graph += order.length > 1 ? `;${order.join('')}concat=n=${order.length}:v=0:a=1[out]` : ';[v]anull[out]';
    args.push('-filter_complex', graph, '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', out);
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Effect failed: ' + (err.trim().split('\n').pop() || 'ffmpeg error').slice(0, 160)))));
      p.stdin.on('error', () => {}); // ffmpeg may close early on a bad filter; the close handler reports it
      p.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    });
  }

  let queue = Promise.resolve();
  function generate(opts) {
    const run = queue.then(() => generateNow(opts));
    queue = run.catch(() => {});
    return run;
  }
  async function generateNow({ text, voice, blend, mix, speed, semitones, effect, before, after }) {
    text = String(text || '').trim();
    if (!text) throw new Error('Type something for the voice to say');
    if (text.length > MAX_TEXT) throw new Error(`Keep it under ${MAX_TEXT} characters`);
    if (!VOICE_IDS.has(voice)) throw new Error('Pick a voice');
    if (blend && !VOICE_IDS.has(blend)) blend = null;
    const fx = EFFECT_BY_ID.get(effect) || EFFECTS[0];
    const opts = {
      voice, blend, mix: Math.min(1, Math.max(0, Number(mix) || 0)),
      speed: Math.min(2, Math.max(0.5, Number(speed) || 1)),
      semitones: Math.round(Math.min(12, Math.max(-12, Number(semitones) || 0))),
    };
    await ensureLoaded();
    const t0 = Date.now();
    const r = await call({ type: 'synth', text, voice: opts.voice, blend: opts.blend, mix: opts.mix, speed: opts.speed });
    const id = crypto.randomUUID().slice(0, 8);
    const file = path.join(TAKE_DIR, id + '.mp3');
    const stingOf = (sid) => { const s = sid && soundPath(sid); return s && fs.existsSync(s.file) ? s : null; };
    await render({ pcm: r.pcm, semitones: opts.semitones, effect: fx, before: stingOf(before), after: stingOf(after), out: file });
    const take = { id, file, text, ...opts, effect: fx.id, ms: Date.now() - t0, created: Date.now() };
    takes.set(id, take);
    // keep the folder small
    if (takes.size > KEEP_TAKES) { const [old] = takes.values(); takes.delete(old.id); fs.rm(old.file, { force: true }, () => {}); }
    return take;
  }

  return {
    events,
    status: () => ({ ...engine, sizeMb: Math.round(MODEL.size / 1e6) }),
    download,
    generate,
    take: (id) => takes.get(id) || null,
    forget(id) { const t = takes.get(id); if (t) { takes.delete(id); fs.rm(t.file, { force: true }, () => {}); } },
    voices: VOICES,
    effects: EFFECTS.map(({ id, name }) => ({ id, name })),
    maxText: MAX_TEXT,
    shutdown: stopWorker,
  };
}

module.exports = { create, VOICES, EFFECTS, MODEL };
