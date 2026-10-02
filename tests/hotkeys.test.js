// The panel names keys from the browser (e.code); the in-game listener names them from uiohook.
// If the two ever disagree, a hotkey would save fine but never fire in-game — so check every common key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { UiohookKey } = require('uiohook-napi');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const keyName = new Function('return ' + html.match(/function keyName\(e\) \{[\s\S]*?\n\}/)[0])();
const numlockOff = { NumpadInsert: 'Num0', NumpadEnd: 'Num1', NumpadArrowDown: 'Num2', NumpadPageDown: 'Num3',
  NumpadArrowLeft: 'Num4', NumpadArrowRight: 'Num6', NumpadHome: 'Num7', NumpadArrowUp: 'Num8', NumpadPageUp: 'Num9', NumpadDelete: 'NumDecimal' };
const hookNames = new Set(Object.keys(UiohookKey).map((k) => numlockOff[k] || k.replace(/^Numpad/, 'Num')));

const codes = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => 'Key' + c),
  ...'0123456789'.split('').map((d) => 'Digit' + d),
  ...'0123456789'.split('').map((d) => 'Numpad' + d),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  ...Array.from({ length: 24 }, (_, i) => 'F' + (i + 1)),
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'CapsLock', 'ScrollLock', 'NumLock', 'PrintScreen',
];

test('every common key the panel can record is one the in-game listener hears', () => {
  const missing = codes.map((code) => keyName({ key: 'x', code })).filter((n) => !hookNames.has(n));
  assert.deepStrictEqual(missing, []);
});

test('modifiers combine in the same order on both sides', () => {
  assert.strictEqual(keyName({ key: 'x', code: 'Numpad3', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Num3');
  assert.strictEqual(keyName({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), null, 'a lone modifier is not a hotkey');
});

test('keys the listener cannot hear are detectable (so the panel can refuse them)', () => {
  for (const code of ['Pause', 'ContextMenu', 'IntlBackslash', 'MediaPlayPause']) {
    assert.ok(!hookNames.has(keyName({ key: 'x', code })), code);
  }
});

test('panel and server use the same numlock-off mapping', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const [k, v] of Object.entries(numlockOff)) assert.ok(server.includes(`${k}: '${v}'`), k);
});
