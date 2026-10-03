# Third-party components

SoundBat's own code is proprietary (see LICENSE). It relies on these open-source parts, and each keeps its own licence.

| Component | Licence | Notes |
|---|---|---|
| discord.js, @discordjs/voice, prism-media | Apache-2.0 | |
| express, multer, busboy, opusscript, uiohook-napi, koffi, @snazzah/davey, ws and ~100 small deps | MIT / ISC / BSD / 0BSD | Attribution only |
| qrcode-generator (`public/qrcode.js`) | MIT, © Kazuhiko Arase | Vendored file; keep its header |
| @ffmpeg-installer/ffmpeg (wrapper) | LGPL-2.1 | |
| **FFmpeg binary** from @ffmpeg-installer/win32-x64 | **GPL-3.0** | See below |
| ffmpeg-static (pulled in by prism-media) | GPL-3.0 | **Not used.** It's excluded from builds in `package.json` |
| Electron / Chromium | MIT + Chromium licences | Shipped as LICENSE files in the build |
| Kokoro-82M model + voices (Voice Lab) | Apache-2.0, © hexgrad | Model downloaded at runtime from the kokoro-onnx release (MIT); voice files in `voices/` |
| kokoro-js (text clean-up / phoneme rules adapted in `voice-worker.js`) | Apache-2.0 | |
| onnxruntime-web, onnxruntime-common | MIT, © Microsoft | |
| **phonemizer** (npm) | Apache-2.0 wrapper around **eSpeak NG (GPL-3.0)** | See below |

## FFmpeg: action needed before you sell builds
SoundBat only runs FFmpeg as a separate program, to decode audio files. That usually counts as "mere aggregation", but the Windows binary it bundles is a GPL-3.0 build. If you distribute that binary, you must include the GPL-3.0 text and offer its source code.

The simpler route is to swap in an **LGPL build** of FFmpeg:
1. Download an LGPL "shared" or "static" Windows build, for example the `*-lgpl` builds from BtbN/FFmpeg-Builds.
2. Put `ffmpeg.exe` in the app, for example under `resources/ffmpeg/`, and set the `FFMPEG_PATH` environment variable. You can also change the one line in `index.js` that picks the path.
3. Remove `@ffmpeg-installer/ffmpeg` from `package.json`.

SoundBat only needs FFmpeg to decode mp3, wav, ogg, m4a, flac, aac and opus. Encoding to Opus happens in `opusscript` (MIT), so an LGPL build is enough.

## Voice Lab: eSpeak NG
Voice Lab turns text into phonemes with the `phonemizer` package, which is eSpeak NG compiled to WebAssembly. The package says Apache-2.0, but eSpeak NG itself is GPL-3.0. That's the same situation as the FFmpeg binary above: if you sell builds that include it, plan to include the GPL-3.0 text and offer the eSpeak NG source, or swap the phonemizer for a permissively licensed one (for example a dictionary-based G2P). The phoneme step is one function (`toPhonemes` in `voice-worker.js`), so it's easy to replace.

*This is general information, not legal advice.*
