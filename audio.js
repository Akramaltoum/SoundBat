// SoundBat audio engine: decodes sounds to raw PCM once (cached on disk), then mixes any number of
// sounds together live and encodes the result to Opus for the Discord voice player.
// Mixing ourselves (instead of one ffmpeg per sound) lets sounds overlap, start instantly,
// and react to volume / stop changes within ~20 ms.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SEC = RATE * CHANNELS * 2;      // s16le stereo
const FRAME_SAMPLES = 960;                       // 20 ms per channel
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 3840
const MAX_CACHE_SEC = 330;                       // longer sounds stream from ffmpeg instead of being cached
const MAX_TRACKS = 8;                            // most sounds allowed to play at once

const align = (n) => Math.max(0, Math.floor(n / 4) * 4);
const secToBytes = (s) => align(Math.round((Number(s) || 0) * BYTES_PER_SEC));

// ---------- decoding ----------
function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || 'ffmpeg failed').slice(0, 200)))));
  });
}

// Decode a sound to <cacheDir>/<id>.pcm (first MAX_CACHE_SEC seconds) and measure it.
async function analyze({ ffmpeg, file, pcmFile }) {
  const tmp = pcmFile + '.part';
  await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-t', String(MAX_CACHE_SEC), '-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), tmp]);
  fs.renameSync(tmp, pcmFile);
  const pcm = fs.readFileSync(pcmFile);
  const m = measure(pcm);
  const long = pcm.length >= (MAX_CACHE_SEC - 0.05) * BYTES_PER_SEC;
  return { duration: long ? null : +(pcm.length / BYTES_PER_SEC).toFixed(3), long, ...m };
}

// Peak and gated loudness (dBFS) of s16le PCM. Gating ignores silence so quiet gaps don't skew it.
function measure(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  let peak = 0;
  const win = RATE * CHANNELS / 20; // 50 ms windows
  const energies = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) {
      const v = samples[j] / 32768;
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    energies.push(sum / Math.max(1, end - i));
  }
  const gate = Math.pow(10, -50 / 10);
  const loudOnes = energies.filter((e) => e > gate);
  const mean = loudOnes.length ? loudOnes.reduce((a, b) => a + b, 0) / loudOnes.length : 0;
  const db = (x) => (x > 0 ? 10 * Math.log10(x) : -120);
  return { peakDb: +(20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1), loudDb: +db(mean).toFixed(1) };
}

// Gain that brings a sound to the target loudness without clipping its peak much.
const TARGET_DB = -17;
function levelGain(s) {
  if (s.loudDb == null || s.loudDb <= -80) return 1;
  let g = Math.pow(10, (TARGET_DB - s.loudDb) / 20);
  const peak = Math.pow(10, (s.peakDb ?? 0) / 20);
  if (peak * g > 1.12) g = 1.12 / peak;
  return Math.min(4, Math.max(0.2, g));
}

// ~n peak values (0..1) for drawing a waveform
function waveform(pcm, n = 400) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = Math.max(2, Math.floor(samples.length / n));
  const out = [];
  for (let i = 0; i < n && i * per < samples.length; i++) {
    let m = 0;
    const end = Math.min(samples.length, (i + 1) * per);
    for (let j = i * per; j < end; j += 2) { const a = Math.abs(samples[j]); if (a > m) m = a; }
    out.push(+(m / 32768).toFixed(3));
  }
  return out;
}

// ---------- small in-memory cache of decoded sounds ----------
class PcmCache {
  constructor(maxBytes = 96 * 1024 * 1024) { this.max = maxBytes; this.map = new Map(); this.size = 0; }
  get(key, loader) {
    let v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); return v; }
    v = loader();
    if (!v) return null;
    this.map.set(key, v); this.size += v.length;
    for (const [k, b] of this.map) {
      if (this.size <= this.max || k === key) break;
      this.map.delete(k); this.size -= b.length;
    }
    return v;
  }
  drop(key) { const v = this.map.get(key); if (v) { this.size -= v.length; this.map.delete(key); } }
}

// ---------- tracks ----------
let nextInstance = 1;

// A sound that's already decoded in memory
class BufferTrack {
  constructor({ id, pcm, start = 0, end = null, loop = false, volume }) {
    this.id = id; this.instance = nextInstance++;
    this.pcm = pcm;
    this.start = Math.min(align(start), pcm.length);
    this.end = end == null ? pcm.length : Math.min(align(end), pcm.length);
    if (this.end <= this.start) this.end = pcm.length;
    this.pos = this.start; this.loop = loop; this.volume = volume; this.done = false;
  }
  get duration() { return (this.end - this.start) / BYTES_PER_SEC; }
  get position() { return (this.pos - this.start) / BYTES_PER_SEC; }
  // Copy up to n bytes into out (Int16Array view); returns bytes written
  read(n) {
    if (this.done) return null;
    if (this.pos >= this.end) {
      if (this.loop && this.end > this.start) this.pos = this.start;
      else { this.done = true; return null; }
    }
    const len = Math.min(n, this.end - this.pos);
    const chunk = this.pcm.subarray(this.pos, this.pos + len);
    this.pos += len;
    return chunk;
  }
  destroy() { this.done = true; }
}

// A long sound streamed from ffmpeg as it plays
class StreamTrack {
  constructor({ id, ffmpeg, file, start = 0, end = null, loop = false, volume }) {
    this.id = id; this.instance = nextInstance++;
    this.args = { ffmpeg, file, start, end };
    this.loop = loop; this.volume = volume; this.done = false; this.played = 0;
    this.durationSec = end != null ? Math.max(0, end - start) : null;
    this.spawn();
  }
  spawn() {
    const { ffmpeg, file, start, end } = this.args;
    const a = ['-hide_banner', '-loglevel', 'error'];
    if (start > 0) a.push('-ss', String(start));
    a.push('-i', file);
    if (end != null) a.push('-t', String(Math.max(0.05, end - start)));
    a.push('-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1');
    this.queue = []; this.queued = 0; this.ended = false;
    const p = this.proc = spawn(ffmpeg, a, { windowsHide: true });
    p.stdout.on('data', (d) => {
      this.queue.push(d); this.queued += d.length;
      if (this.queued > BYTES_PER_SEC * 2) p.stdout.pause(); // stay ~2 s ahead
    });
    const fin = () => { this.ended = true; };
    p.stdout.on('end', fin); p.on('error', fin); p.on('close', fin);
    p.stderr.resume();
  }
  get duration() { return this.durationSec; }
  get position() { return this.played / BYTES_PER_SEC; }
  read(n) {
    if (this.done) return null;
    if (!this.queued) {
      if (!this.ended) return Buffer.alloc(0); // still starting up: silence for now
      if (this.loop && this.played > 0) { this.played = 0; this.spawn(); return Buffer.alloc(0); }
      this.done = true; return null;
    }
    const parts = []; let got = 0;
    while (got < n && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, n - got);
      parts.push(head.subarray(0, take)); got += take;
      if (take === head.length) this.queue.shift(); else this.queue[0] = head.subarray(take);
    }
    this.queued -= got; this.played += got;
    if (this.queued < BYTES_PER_SEC) this.proc.stdout.resume();
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
  }
  destroy() { this.done = true; try { this.proc.kill(); } catch {} }
}

// Opus encoder: the app ships opusscript (and the voice library carries its own copy as a backup)
let OpusLib = null;
function loadOpus() {
  if (OpusLib) return OpusLib;
  for (const name of ['opusscript', '@discordjs/voice/node_modules/opusscript']) {
    try { OpusLib = require(name); return OpusLib; } catch {}
  }
  throw new Error('Opus encoder missing — reinstall SoundBat');
}

// ---------- mixer ----------
// An object-mode stream of Opus packets. It keeps at most one packet buffered, so anything
// added or changed shows up in the call on the next 20 ms frame.
class Mixer extends Readable {
  constructor({ OpusScript, onTrackEnd } = {}) {
    super({ objectMode: true, highWaterMark: 1 });
    const Opus = OpusScript || loadOpus();
    this.encoder = new Opus(RATE, CHANNELS, Opus.Application.AUDIO);
    this.tracks = [];
    this.onTrackEnd = onTrackEnd || (() => {});
    this.acc = new Int32Array(FRAME_SAMPLES * CHANNELS);
    this.out = Buffer.alloc(FRAME_BYTES);
    this.finished = false;
  }
  add(track) {
    if (this.finished) return false;
    this.tracks.push(track);
    while (this.tracks.length > MAX_TRACKS) this.remove(this.tracks[0]);
    return true;
  }
  remove(track) {
    const i = this.tracks.indexOf(track);
    if (i >= 0) { this.tracks.splice(i, 1); track.destroy(); this.onTrackEnd(track); }
  }
  clear() { [...this.tracks].forEach((t) => this.remove(t)); }
  // Mix one 20 ms frame into this.out; returns how many bytes of sound went into it
  mixFrame() {
    const acc = this.acc; acc.fill(0);
    let mixed = 0;
    for (const t of [...this.tracks]) {
      let filled = 0;
      const vol = Math.max(0, Number(t.volume()) || 0);
      while (filled < FRAME_BYTES) {
        const chunk = t.read(FRAME_BYTES - filled);
        if (chunk === null) { this.remove(t); break; }
        if (!chunk.length) break; // stream track warming up
        const s = new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));
        const off = filled / 2;
        for (let i = 0; i < s.length; i++) acc[off + i] += s[i] * vol;
        filled += chunk.length;
      }
      mixed += filled;
    }
    const out = this.out;
    for (let i = 0; i < acc.length; i++) {
      let v = acc[i];
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out.writeInt16LE(v | 0, i * 2);
    }
    return mixed;
  }
  _read() {
    if (this.finished) return;
    if (!this.tracks.length) { this.finish(); return; }
    const mixed = this.mixFrame(); // a sound ending mid-frame still gets its last few ms out
    if (!mixed && !this.tracks.length) { this.finish(); return; }
    this.push(Buffer.from(this.encoder.encode(this.out, FRAME_SAMPLES)));
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.clear();
    try { this.encoder.delete(); } catch {}
    this.push(null);
  }
  _destroy(err, cb) { this.finished = true; this.clear(); try { this.encoder.delete(); } catch {} cb(err); }
}

module.exports = {
  RATE, CHANNELS, BYTES_PER_SEC, FRAME_BYTES, MAX_CACHE_SEC, MAX_TRACKS,
  analyze, measure, levelGain, waveform, secToBytes, PcmCache, BufferTrack, StreamTrack, Mixer, runFfmpeg,
};
