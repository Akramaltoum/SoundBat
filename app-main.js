// SoundBat desktop app: splash screen, then the soundboard (bot + panel + in-game hotkeys) in its own window.
// Lives in the tray when closed so in-game hotkeys keep working.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, Menu, ipcMain, clipboard, Tray, nativeImage, screen, Notification, powerSaveBlocker } = require('electron');

// Keep using the original data folder so sounds/settings carry over from "Soundboard"
app.setPath('userData', path.join(app.getPath('appData'), 'Soundboard'));
// Only one SoundBat at a time — a second copy would log the same bot in twice
if (!app.requestSingleInstanceLock()) { app.exit(0); return; }

const ICON = path.join(__dirname, 'icon.png');
try { app.setAppUserModelId(require('./package.json').build?.appId || 'com.soundbat.app'); } catch {} // lets Windows show SoundBat's notifications
const HIDDEN = process.argv.includes('--hidden'); // started with Windows: go straight to the tray

// Small run log next to the code (helps diagnose updates): resources/app-update/last-run.log
const RUN_LOG = path.join(__dirname, 'last-run.log');
function runLog(...parts) {
  try { fs.appendFileSync(RUN_LOG, new Date().toISOString() + ' ' + parts.map(String).join(' ') + '\n'); } catch {}
}
try { fs.writeFileSync(RUN_LOG, ''); } catch {}
runLog('start', 'code:', __dirname, 'electron:', process.versions.electron);
process.on('uncaughtException', (e) => runLog('uncaught', e && e.stack || e));
process.on('unhandledRejection', (e) => runLog('unhandled', e && e.stack || e));
const INTRO_MS = 2600; // splash intro length before it can hand off
let win = null;
let splash = null;
let tray = null;
let quitting = false;
let soundboard = null; // index.js exports
let trayHintShown = false;

// Remember where the window was
const BOUNDS_FILE = path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
      b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 10 && b.y < w.y + w.height - 60);
    return onScreen ? b : { width: b.width, height: b.height };
  } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isMinimized() || win.isMaximized()) return;
  try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds())); } catch {}
}

function createSplash() {
  splash = new BrowserWindow({
    width: 620, height: 380, frame: false, resizable: false, center: true, show: false,
    backgroundColor: '#0a0814', icon: ICON, title: 'SoundBat',
    webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'splash-preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => { splash = null; });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('SoundBat');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SoundBat', click: showWindow },
      { label: 'Stop all sounds', click: () => soundboard?.stopAll() },
      { type: 'separator' },
      { label: 'Quit SoundBat', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) { runLog('tray failed', e && e.message); tray = null; }
}

function applyLoginItem(db) {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!db.openAtLogin, args: ['--hidden'] }); } catch (e) { runLog('login item failed', e.message); }
}

// macOS App Nap slows the timers of apps that aren't in front (e.g. while you're in a game), which
// delays sounds and makes them stutter. Keep SoundBat awake while it's in a call.
let awakeId = null;
function keepAwake(on) {
  if (process.platform !== 'darwin') return;
  try {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    else if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  } catch (e) { runLog('keep awake failed', e.message); }
}

// An Intel build on an Apple Silicon Mac runs through Rosetta: everything works, just slower
function warnIfTranslated() {
  if (!app.runningUnderARM64Translation) return;
  runLog('running under Rosetta/emulation, arch', process.arch);
  if (process.platform === 'darwin' && Notification.isSupported()) {
    new Notification({ title: 'SoundBat is running in Intel mode', body: 'For the snappiest hotkeys, rebuild it for Apple Silicon (see MAC-SETUP.txt).', icon: ICON, silent: true }).show();
  }
}

app.whenReady().then(async () => {
  // macOS routes Cmd+C/V/X/A and Cmd+Q through the app menu, so keep a minimal one there
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  if (!HIDDEN) createSplash();
  const started = Date.now();

  // Let the splash paint before loading the heavy bot/server code
  await new Promise((r) => setTimeout(r, 300));
  process.env.SOUNDBOARD_DATA = path.join(app.getPath('userData'), 'data');
  let port;
  try { soundboard = require('./index.js'); port = await soundboard.ready; runLog('server on port', port, 'code', soundboard.version); }
  catch (e) { runLog('server failed', e && e.stack || e); throw e; }

  createTray();
  applyLoginItem(soundboard.settings());
  soundboard.events.on('settings', applyLoginItem);
  soundboard.events.on('busy', keepAwake);
  warnIfTranslated();

  win = new BrowserWindow({
    width: 940,
    height: 600,
    ...loadBounds(),
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: 'SoundBat',
    icon: ICON,
    backgroundColor: '#0a0814',
    frame: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL(`http://localhost:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url); // invite / portal links open in your browser
    return { action: 'deny' };
  });
  // Links inside the panel never navigate the app window away
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    // Closing hides to the tray (hotkeys keep working) unless you turned that off or chose Quit
    if (!quitting && tray && soundboard?.settings().closeToTray) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'SoundBat is still running', body: 'Your hotkeys still work. Right-click the bat in the tray to quit.', icon: ICON, silent: true }).show();
      }
    }
  });
  win.on('closed', () => { win = null; });

  await new Promise((r) => win.once('ready-to-show', r));
  if (HIDDEN) { setTimeout(() => splash?.close(), 0); return; }
  const left = INTRO_MS - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));

  if (splash) {
    splash.webContents.send('splash:ready');     // plays the finale (flash + swoop)
    await new Promise((r) => setTimeout(r, 700));
  }
  win.show();
  win.focus();
  setTimeout(() => splash?.close(), 150);
});

// Setup helper: hand back the clipboard ONLY if it looks like a Discord bot token (nothing else leaves it)
ipcMain.handle('setup:clip-token', () => {
  const t = (clipboard.readText() || '').trim();
  return /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t) ? t : null;
});

ipcMain.on('win', (_e, action) => {
  if (!win) return;
  if (action === 'focus') { showWindow(); win.setAlwaysOnTop(true); setTimeout(() => win?.setAlwaysOnTop(false), 300); }
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
  if (action === 'quit') { quitting = true; app.quit(); }
});

// Restart button in the panel (used after an update lands)
ipcMain.on('app:restart', () => { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') }); app.exit(0); });

// Watch for updated code dropped into resources/app-update and tell the panel
function watchForUpdates() {
  const dir = global.SOUNDBAT?.updateDir;
  if (!dir) return;
  let timer = null;
  try {
    fs.watch(dir, { recursive: true }, (_ev, file) => {
      // our own log file changes all the time — that's not an update
      if (!file || /last-run\.log$|\.tmp$/.test(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(() => win?.webContents.send('app:update-ready'), 1500);
    });
  } catch (e) { console.error('Update watcher unavailable:', e.message); }
}
app.whenReady().then(() => setTimeout(watchForUpdates, 5000));

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow()); // macOS: clicking the Dock icon brings back a window hidden to the tray
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
