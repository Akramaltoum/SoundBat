// SoundBat bootstrap. Loads the app code from resources/app-update when an update has been
// dropped there (so updates are just a restart), otherwise the code built into the app.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const UPDATE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app-update') : null;
let entry = path.join(__dirname, 'app-main.js');

if (UPDATE_DIR) {
  try { fs.mkdirSync(UPDATE_DIR, { recursive: true }); } catch {}
  if (fs.existsSync(path.join(UPDATE_DIR, 'app-main.js'))) {
    // Let the updated code use the libraries bundled with the app
    process.env.NODE_PATH = path.join(__dirname, 'node_modules');
    require('module').Module._initPaths();
    entry = path.join(UPDATE_DIR, 'app-main.js');
  }
}
global.SOUNDBAT = { updateDir: UPDATE_DIR, codeDir: path.dirname(entry) };

try {
  require(entry);
} catch (e) {
  console.error('Updated code failed to start, using built-in version:', e);
  if (entry !== path.join(__dirname, 'app-main.js')) require(path.join(__dirname, 'app-main.js'));
  else throw e;
}
