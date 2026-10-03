# SoundBat

A neon desktop soundboard for Discord. Click a pad, press a hotkey mid-game, or tap your phone, and your own Discord bot plays the sound for everyone in your voice channel.

- **No Nitro and no 5-second limit.** Sounds can be up to 25 MB, and there's no cap on how many you have.
- **Hotkeys that work in-game**, system-wide.
- **Your mic is untouched.** The bot does the playing, so no virtual audio cable is needed and you can talk over it.

## Features
- Overlapping sounds (up to 8), with instant start from a PCM cache and a live mixer (about 20 ms response)
- Auto-levelled loudness, per-sound volume, a waveform trim editor, loop, and "press again to stop"
- Boards (tabs), search, random pad + random hotkey, drag-to-reorder, right-click to edit
- Add sounds by drag-and-drop, file picker, or a link (a direct audio file or a sound-button page)
- Phone remote over Wi-Fi, set up with a QR code, key-protected, play/stop only
- Stream Deck / macro trigger links for each sound
- Tray mode, start with Windows, leave the call when idle, GitHub release update banner
- A first-run wizard that walks the user through creating a bot, inviting it and picking themselves (about 3 minutes)
- A profile with avatar and 5 glow themes
- **Voice Lab**: type anything → natural AI voice clip (28 voices, voice blending, speed/pitch, 18 effects, add a pad before/after) → save to the board. Runs locally (Kokoro-82M on ONNX Runtime WebAssembly); the ~90 MB model downloads once on first use

## Security
- The local server listens on 127.0.0.1 only. The phone remote is a separate listener that is off by default.
- Changes need an `X-SoundBat` header, which blocks cross-site request forgery (CSRF). The `Host` header must be localhost, which blocks DNS rebinding.
- Phone and Stream Deck access uses a 144-bit key, compared in constant time and stored in an HttpOnly, SameSite=Strict cookie. That access is limited to play/stop.
- The bot token is encrypted at rest with Electron `safeStorage` (DPAPI on Windows).
- Saves are atomic, and a damaged save file is set aside rather than overwritten.

## Tech
Electron 44 · Node 22 · discord.js 14 · Kokoro-82M + onnxruntime-web (Voice Lab) · @discordjs/voice 0.19 (with DAVE end-to-end encryption) · Express · uiohook-napi (global hotkeys) · opusscript · FFmpeg

| File | What it does |
|---|---|
| `main.js` | Bootstrap. Loads `resources/app-update/` if present, so updates are just dropped-in files |
| `app-main.js` | Electron shell: splash, window, tray, single instance, login item |
| `index.js` | Bot, playback, hotkeys, HTTP API, live updates (Server-Sent Events), phone remote |
| `audio.js` | Decoding + cache, loudness measurement, waveform, mixer → Opus |
| `voice.js` | Voice Lab: model download (sha256-checked), worker management, effects/stings via FFmpeg |
| `voice-worker.js` | Text → phonemes → Kokoro model, in a worker thread |
| `voices/` | 28 Kokoro voice style files + phoneme vocabulary |
| `public/index.html` | The whole UI (vanilla JS, no build step) |
| `tests/` | 53 tests: audio, API/security, hotkey mapping, UI + Voice Lab (Playwright) |

## Run from source
```bash
npm install
npm run app        # desktop app
npm start          # script mode: needs .env with DISCORD_TOKEN and OWNER_ID, panel at http://localhost:3000
```

## Test
```bash
npm test                                   # audio + API + hotkeys (36 tests)
npm i -D playwright-core && npm run test:ui  # UI in Chromium (10 tests)
node --test tests/voicelab.test.js         # Voice Lab end-to-end (7 tests, downloads the model)
```
On a headless Linux box, run the hotkey tests under `xvfb-run`.

## Build (Windows)
```bash
npm run dist       # electron-builder → dist/SoundBat.zip
```
Before you ship, set `author`, `build.appId` and `build.publish.owner/repo` in `package.json`. Also read `THIRD_PARTY_NOTICES.md`, which covers FFmpeg licensing.

## Data location
`%APPDATA%\Soundboard\data`: `sounds/`, `cache/`, `models/` (Voice Lab engine), `sounds.json`, `config.json`.
