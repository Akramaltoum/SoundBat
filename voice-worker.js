// Voice Lab worker: turns text into speech with the Kokoro-82M model (Apache-2.0) running on
// ONNX Runtime (WebAssembly build — no native files, works on Windows and Mac).
// Runs in its own thread so generating a clip never stutters sounds playing in the call.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE_RATE = 24000;
const MAX_PHONEMES = 510;
const VOICE_DIR = workerData.voiceDir;
const vocab = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'vocab.json'), 'utf8'));

let ort = null, session = null, phonemize = null;
const voiceCache = new Map();

async function load(modelFile) {
  if (session) return;
  ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = Math.max(1, Math.min(6, (os.availableParallelism?.() || os.cpus().length) - 1));
  ort.env.logLevel = 'error';
  ({ phonemize } = require('phonemizer'));
  session = await ort.InferenceSession.create(fs.readFileSync(modelFile), { executionProviders: ['wasm'] });
}

function voiceData(name) {
  if (!/^[a-z]{2}_[a-z]+$/.test(name)) throw new Error('Unknown voice');
  if (!voiceCache.has(name)) {
    const buf = fs.readFileSync(path.join(VOICE_DIR, name + '.bin'));
    voiceCache.set(name, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
  }
  return voiceCache.get(name);
}

// ---------- text → phonemes (adapted from kokoro-js, Apache-2.0) ----------
const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');
function normalize(t) {
  return t.replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"').replace(/[^\S \n]/g, ' ').replace(/ {2,}/g, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/(?<=\d),(?=\d)/g, '').replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S").replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-').trim();
}
async function toPhonemes(text, lang) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT_RE)) {
    if (last < m.index) parts.push({ punct: false, text: text.slice(last, m.index) });
    if (m[0].length) parts.push({ punct: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ punct: false, text: text.slice(last) });
  const out = (await Promise.all(parts.map(async (p) => (p.punct ? p.text : (await phonemize(p.text, lang)).join(' '))))).join('');
  let ps = out.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'en-us') ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}

// Long text: cut the phonemes into model-sized batches, preferring sentence ends, then commas, then spaces
function batches(ps) {
  const out = [];
  while (ps.length > MAX_PHONEMES) {
    const head = ps.slice(0, MAX_PHONEMES);
    let cut = Math.max(...['.', '!', '?', '…'].map((c) => head.lastIndexOf(c)));
    if (cut < 100) cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'));
    if (cut < 100) cut = head.lastIndexOf(' ');
    if (cut < 1) cut = MAX_PHONEMES - 1;
    out.push(ps.slice(0, cut + 1).trim());
    ps = ps.slice(cut + 1).trim();
  }
  if (ps) out.push(ps);
  return out;
}

// Cut dead air off the start and end (keeps a few ms so words aren't clipped)
function trimSilence(pcm, thresh = 0.01, keep = 0.04) {
  let a = 0, b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a]) < thresh) a++;
  while (b > a && Math.abs(pcm[b]) < thresh) b--;
  const pad = Math.round(SAMPLE_RATE * keep);
  return pcm.subarray(Math.max(0, a - pad), Math.min(pcm.length, b + pad));
}

async function speakOne(ps, style, speed) {
  const ids = [...ps].map((c) => vocab[c]).filter((v) => v != null).slice(0, MAX_PHONEMES);
  if (!ids.length) return new Float32Array(0);
  const row = Math.min(ids.length, 510) - 1;
  const tokens = new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, ids.length + 2]);
  const feeds = {
    [session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens']: tokens,
    style: new ort.Tensor('float32', style.subarray(row * 256, row * 256 + 256), [1, 256]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  };
  const r = await session.run(feeds);
  return r[session.outputNames[0]].data;
}

// Style for a row count: one voice, or two blended (mix 0..1 = how much of the second voice)
function styleFor(voice, blend, mix) {
  const a = voiceData(voice);
  if (!blend || blend === voice || !(mix > 0)) return a;
  const b = voiceData(blend);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - mix) + b[i] * mix;
  return out;
}

async function synth({ text, voice, blend, mix, speed }) {
  const lang = voice[0] === 'b' ? 'en' : 'en-us';
  const style = styleFor(voice, blend, mix);
  const ps = await toPhonemes(normalize(text), lang);
  const parts = [];
  for (const b of batches(ps)) parts.push(trimSilence(await speakOne(b, style, speed)), new Float32Array(Math.round(SAMPLE_RATE * 0.15)));
  parts.pop();
  const len = parts.reduce((n, p) => n + p.length, 0);
  if (!len) throw new Error("Couldn't turn that into speech — try some words");
  const pcm = new Float32Array(len);
  let o = 0;
  for (const p of parts) { pcm.set(p, o); o += p.length; }
  return pcm;
}

parentPort.on('message', async (m) => {
  try {
    if (m.type === 'load') { await load(m.modelFile); parentPort.postMessage({ id: m.id, ok: true }); return; }
    if (m.type === 'synth') {
      const pcm = await synth(m);
      parentPort.postMessage({ id: m.id, ok: true, pcm, rate: SAMPLE_RATE }, [pcm.buffer]);
    }
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
});
