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
