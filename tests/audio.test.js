// Audio engine tests: decoding/analysis, mixing math, and playback through the real @discordjs/voice player.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OpusScript = require('opusscript');
const A = require('../audio');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbaudio-'));
const starter = (n) => path.join(__dirname, '..', 'starter', n + '.mp3');

function sine(sec, amp = 0.5, hz = 440) {
  const n = Math.round(sec * A.RATE);
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * hz * i / A.RATE) * amp * 32767); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2); }
  return b;
}
// Read the mixer the way the voice player does: one packet at a time, letting I/O run in between
async function drain(m) {
  const packets = [];
  await new Promise((resolve) => {
    const step = () => {
      const p = m.read();
      if (p) packets.push(p);
      if (m.readableEnded || (m.finished && m.readableLength === 0 && !p)) return resolve();
      setTimeout(step, 1);
    };
    m.on('end', resolve);
    step();
  });
  return packets;
}
function decodePackets(packets) {
  const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const out = Buffer.concat(packets.map((p) => Buffer.from(dec.decode(p))));
  dec.delete();
  return out;
}

test('analyze decodes a starter sound and measures it', async () => {
  const pcmFile = path.join(tmp, 'airhorn.pcm');
  const r = await A.analyze({ ffmpeg, file: starter('Air Horn'), pcmFile });
  assert.ok(r.duration > 0.3 && r.duration < 10, 'duration ' + r.duration);
  assert.strictEqual(r.long, false);
  assert.ok(r.peakDb <= 0.1 && r.peakDb > -30, 'peak ' + r.peakDb);
  assert.ok(r.loudDb < r.peakDb, 'loudness below peak');
  assert.strictEqual(fs.statSync(pcmFile).size % 4, 0);
});

test('analyze rejects a non-audio file with a readable error', async () => {
  const bad = path.join(tmp, 'bad.mp3'); fs.writeFileSync(bad, 'not audio at all');
  await assert.rejects(A.analyze({ ffmpeg, file: bad, pcmFile: path.join(tmp, 'bad.pcm') }), /./);
  assert.ok(!fs.existsSync(path.join(tmp, 'bad.pcm')));
});

test('levelGain boosts quiet sounds, tames loud ones, never exceeds limits', () => {
  assert.ok(A.levelGain({ loudDb: -35, peakDb: -20 }) > 1);
  assert.ok(A.levelGain({ loudDb: -5, peakDb: 0 }) < 1);
  assert.ok(A.levelGain({ loudDb: -60, peakDb: -59 }) <= 4);
  assert.strictEqual(A.levelGain({}), 1);
  const g = A.levelGain({ loudDb: -30, peakDb: -1 });
  assert.ok(Math.pow(10, -1 / 20) * g <= 1.121, 'peak protected');
});

test('BufferTrack honours trim and loop', () => {
  const pcm = sine(1);
  const t = new A.BufferTrack({ id: 'a', pcm, start: A.secToBytes(0.25), end: A.secToBytes(0.5), volume: () => 1 });
  assert.ok(Math.abs(t.duration - 0.25) < 0.001);
  let total = 0, c; while ((c = t.read(3840))) total += c.length;
  assert.strictEqual(total, A.secToBytes(0.25));
  const l = new A.BufferTrack({ id: 'b', pcm, loop: true, volume: () => 1 });
  let got = 0; for (let i = 0; i < 100; i++) got += l.read(3840).length;
  assert.strictEqual(got, 384000, 'loop keeps going past the end');
});

test('mixer sums overlapping sounds, clamps, and applies live volume', () => {
  const m = new A.Mixer({ OpusScript });
  const quiet = sine(0.1, 0.3); const loud = sine(0.1, 0.9);
  let vol = 1;
  m.add(new A.BufferTrack({ id: 'q', pcm: quiet, volume: () => vol }));
  m.add(new A.BufferTrack({ id: 'l', pcm: loud, volume: () => 1 }));
  m.mixFrame();
  let max = 0; for (let i = 0; i < 3840; i += 2) max = Math.max(max, Math.abs(m.out.readInt16LE(i)));
  assert.ok(max >= 32767 && max <= 32768, 'clamped instead of wrapping');
  vol = 0; m.clear();
  m.add(new A.BufferTrack({ id: 'q', pcm: quiet, volume: () => vol }));
  m.mixFrame();
  let any = 0; for (let i = 0; i < 3840; i += 2) any = Math.max(any, Math.abs(m.out.readInt16LE(i)));
  assert.strictEqual(any, 0, 'volume 0 is silent');
  m.destroy();
});

test('mixer caps simultaneous sounds and reports ended tracks', () => {
  const ended = [];
  const m = new A.Mixer({ OpusScript, onTrackEnd: (t) => ended.push(t.id) });
  for (let i = 0; i < A.MAX_TRACKS + 3; i++) m.add(new A.BufferTrack({ id: 's' + i, pcm: sine(0.05), volume: () => 1 }));
  assert.strictEqual(m.tracks.length, A.MAX_TRACKS);
  assert.deepStrictEqual(ended, ['s0', 's1', 's2']);
  m.destroy();
});

test('mixer stream produces the right amount of Opus audio then ends', async () => {
  const m = new A.Mixer({ OpusScript });
  m.add(new A.BufferTrack({ id: 'x', pcm: sine(0.5), volume: () => 1 }));
  const packets = await drain(m);
  assert.strictEqual(packets.length, 25, '0.5 s = 25 frames');
  const pcm = decodePackets(packets);
  const m2 = A.measure(pcm);
  assert.ok(m2.peakDb > -9 && m2.peakDb < 0, 'decoded audio is really there: ' + m2.peakDb);
  assert.strictEqual(m.add(new A.BufferTrack({ id: 'late', pcm: sine(0.1), volume: () => 1 })), false, 'finished mixer refuses new tracks');
});

test('StreamTrack plays long files through ffmpeg with trimming', async () => {
  const m = new A.Mixer({ OpusScript });
  m.add(new A.StreamTrack({ id: 'st', ffmpeg, file: starter('Drumroll'), start: 0.2, end: 1.2, volume: () => 1 }));
  const packets = await drain(m);
  const sec = packets.length * 0.02;
  assert.ok(sec >= 0.95 && sec <= 1.4, 'about 1 s of audio, got ' + sec);
});

test('real AudioPlayer plays the mixer, overlaps a second sound, and stops instantly', async () => {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const m = new A.Mixer({ OpusScript });
  m.add(new A.BufferTrack({ id: 'one', pcm: sine(0.6), volume: () => 1 }));
  const res = createAudioResource(m, { inputType: StreamType.Opus });
  player.play(res);
  await new Promise((r) => player.once(AudioPlayerStatus.Playing, r));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  m.add(new A.BufferTrack({ id: 'two', pcm: sine(0.6, 0.2, 660), volume: () => 1 }));
  assert.deepStrictEqual(m.tracks.map((t) => t.id), ['one', 'two']);
  await new Promise((r) => player.once(AudioPlayerStatus.Idle, r));
  const ms = Date.now() - t0;
  assert.ok(ms > 750 && ms < 1400, 'second sound extended playback to ~0.9 s, took ' + ms);

  const m2 = new A.Mixer({ OpusScript });
  m2.add(new A.BufferTrack({ id: 'long', pcm: sine(5), volume: () => 1 }));
  player.play(createAudioResource(m2, { inputType: StreamType.Opus }));
  await new Promise((r) => player.once(AudioPlayerStatus.Playing, r));
  const s0 = Date.now();
  player.stop(true);
  assert.strictEqual(player.state.status, AudioPlayerStatus.Idle);
  assert.ok(Date.now() - s0 < 50);
});

test('PcmCache evicts least recently used', () => {
  const c = new A.PcmCache(10);
  c.get('a', () => Buffer.alloc(4)); c.get('b', () => Buffer.alloc(4));
  c.get('a', () => null);
  c.get('c', () => Buffer.alloc(4));
  assert.ok(c.map.has('a') && c.map.has('c') && !c.map.has('b'));
});

test('waveform returns normalised peaks', () => {
  const w = A.waveform(sine(1, 0.5), 100);
  assert.strictEqual(w.length, 100);
  assert.ok(w.every((v) => v >= 0 && v <= 1));
  assert.ok(Math.abs(Math.max(...w) - 0.5) < 0.02);
});
