// SoundBat desktop app: splash screen, then the soundboard (bot + panel + in-game hotkeys) in its own window.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, Menu, ipcMain, clipboard } = require('electron');

// Keep using the original data folder so sounds/settings carry over from "Soundboard"
app.setPath('userData', path.join(app.getPath('appData'), 'Soundboard'));
if (!app.requestSingleInstanceLock()) app.quit();

const ICON = path.join(__dirname, 'icon.png');

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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createSplash();
  const started = Date.now();

  // Let the splash paint before loading the heavy bot/server code
  await new Promise((r) => setTimeout(r, 300));
  process.env.SOUNDBOARD_DATA = path.join(app.getPath('userData'), 'data');
  let port;
  try { port = await require('./index.js').ready; runLog('server on port', port); }
  catch (e) { runLog('server failed', e && e.stack || e); throw e; }

  win = new BrowserWindow({
    width: 940,
    height: 600,
    minWidth: 520,
    minHeight: 420,
    center: true,
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
  win.on('closed', () => { win = null; });

  await new Promise((r) => win.once('ready-to-show', r));
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
  if (action === 'focus') { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.setAlwaysOnTop(true); setTimeout(() => win?.setAlwaysOnTop(false), 300); }
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
});

// Restart button in the panel (used after an update lands)
ipcMain.on('app:restart', () => { app.relaunch(); app.exit(0); });

// Watch for updated code dropped into resources/app-update and tell the panel
function watchForUpdates() {
  const dir = global.SOUNDBAT?.updateDir;
  if (!dir) return;
  let timer = null;
  try {
    fs.watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => win?.webContents.send('app:update-ready'), 1500);
    });
  } catch (e) { console.error('Update watcher unavailable:', e.message); }
}
app.whenReady().then(() => setTimeout(watchForUpdates, 5000));

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => app.quit());
