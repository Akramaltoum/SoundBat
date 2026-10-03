// npm run dist:mac — builds SoundBat.app for this Mac's CPU.
// The app's native parts (ffmpeg, hotkeys, voice encryption) come from `npm install`, which picks them for
// the CPU Node runs as. Intel Node on an Apple Silicon Mac would make a slower Intel app that runs
// through Rosetta, so stop and say how to fix it instead.
const { execSync } = require('child_process');

let appleSilicon = false;
try { appleSilicon = execSync('sysctl -in hw.optional.arm64').toString().trim() === '1'; } catch {}
if (appleSilicon && process.arch !== 'arm64') {
  console.error('\nThis Mac has an Apple Silicon chip, but the Node.js you installed is the Intel version.');
  console.error('Install the macOS "ARM64" / Apple Silicon Node.js from https://nodejs.org, then delete the');
  console.error('node_modules folder and run "npm install" and "npm run dist:mac" again.\n');
  process.exit(1);
}
execSync('npx electron-builder --mac --dir --' + process.arch, { stdio: 'inherit' });
