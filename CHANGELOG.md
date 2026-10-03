# SoundBat 1.3.1

## Faster hotkeys
- Sounds reach the call sooner after a hotkey press. On Windows, packets were going out every 16 or 32 ms instead of every 20 ms, so everyone listening buffered SoundBat's audio longer to smooth it out. SoundBat now asks Windows for a precise timer while a sound plays.
- The first press after starting no longer waits ~130 ms for the Opus encoder to load. It's warmed up at startup.
- Sounds with a hotkey stay decoded in memory, so a press never waits on the disk.
- A sound pressed while another plays joins the mix on the very next 20 ms frame (one frame sooner than before).
- Windows 11: SoundBat opts out of power throttling ("efficiency mode"), so the precise timer keeps working while the window is in the tray or behind a game.
- Mac: while SoundBat is in a call it keeps macOS App Nap from slowing it down when a game is in front. An Intel build running on an Apple Silicon Mac now says so, and `npm run dist:mac` refuses to build with Intel Node on Apple Silicon.

# SoundBat 1.3.0

## New
- **Voice Lab tab** — type anything and SoundBat speaks it in a natural AI voice, then save it as a pad. Runs on your PC (Kokoro-82M model, one-time ~90 MB download on first use; no account, no API key, no per-clip cost, works offline after that).
  - 28 voices (US + UK, male + female) and **Mix with** — blend two voices into a new one.
  - Speed (0.5–2×) and pitch (±12 semitones) sliders.
  - 18 one-click effects: Hype, Deep, Demon, Chipmunk, Robot, Walkie-talkie, Phone call, Megaphone, Stadium, Cave echo, Underwater, Alien, Ghost, Slow-mo, Fast-forward, Backwards, Blown out.
  - **Sound before / after** — tack any pad from your board onto the clip (drumroll → announcement, roast → air horn). Pieces are loudness-matched.
  - Takes list: preview privately, **Play in call** without saving, **Save to board** with a name and board, click a take to load its settings back.
  - **Surprise me** — random line, voice and effect. Ctrl+Enter generates.
  - In-game hotkeys pause while you type in Voice Lab, so letters don't fire sounds.
  - Generation runs in a background thread, so sounds already playing in the call never stutter.

## Tests
`tests/voicelab.test.js` (7 tests: engine download, generate, preview, save, API guards, narrow layout).

# SoundBat 1.2.0

## New
- **Sounds overlap** — hit several pads and they all play together (up to 8), like Discord's own soundboard. Turn off in Settings → "Let sounds overlap" to go back to one-at-a-time.
- **Instant playback** — sounds are decoded once and cached, so there's no ffmpeg start-up delay. Stop, volume and new sounds reach the call on the next 20 ms frame.
- **Even out loudness** — every sound is measured and levelled so an air horn doesn't blow ears out and quiet clips aren't lost. On by default; your per-sound volume still applies on top.
- **Trim** — drag the start/end lines on the waveform in the Edit dialog. Preview plays just the trimmed part.
- **Loop** and **Press again to stop** per sound.
- **Boards** — tabs for organising sounds (Edit → "+ Board"; double-click a tab to rename/delete; drag a pad onto a tab to move it).
- **Search** — Ctrl+F or `/`; Enter plays the top match; Esc clears.
- **Random** button (random sound from the current board) and a **Random sound key**.
- **Add from a link** — paste a direct .mp3 link or a sound-button page.
- **Progress bar** and length on each pad.
- **Phone remote** — Settings → Phone: switch on, scan the QR code. The phone can only play/stop; it can't change settings.
- **Stream Deck / macro links** — Edit a sound → "Copy link". Works with Stream Deck "Website" buttons.
- **Tray** — closing the window keeps SoundBat in the tray so in-game hotkeys keep working. **Start with Windows** option.
- **Leave the call when idle** option (5 min – 1 hour).
- **Update check** — a banner appears when a newer release is on GitHub.
- Right-click any pad to edit it. Window size/position is remembered. Clear messages when the bot lacks Connect/Speak permission or the channel is full.

## Fixed
- **Security:** any website open in your browser could press buttons in SoundBat (log you out, play sounds, upload files) because the local server accepted cross-site requests. Now every change needs a header only the app sends, the Host must be `localhost` (blocks DNS-rebinding), and phone access needs a secret key.
- **Bot token is now encrypted** on disk with your Windows login (DPAPI) instead of plain text.
- Errors from hotkeys kept flashing back every few seconds forever.
- Pressing Enter after renaming a sound hit *Cancel* and threw the change away.
- The "SoundBat has been updated" banner could appear for no reason (the app's own log file tripped the update watcher).
- A second copy of SoundBat could start and log the same bot in twice.
- Files over 25 MB showed "Request failed" instead of saying why.
- Non-audio files renamed to .mp3 were accepted and only failed later when played — now rejected on upload with a clear message.
- Saving is crash-safe (write-then-swap), and a damaged sounds.json is set aside instead of silently replaced with an empty board.
- Keys the in-game listener can't hear (Pause, media keys…) could be saved as hotkeys and silently never worked — now refused, with a warning for risky keys like plain letters.
- Reordering with an out-of-date list could shuffle sounds.

## Tests
`npm test` (audio engine, API + security, hotkey names) and `npm run test:ui` (panel in Chromium via playwright-core) — 46 tests.
