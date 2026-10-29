const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const shortcuts = require('./shortcuts');
const { normalizeAccelerator, isValidAccelerator, acceleratorFor, readKeybindings, validateKeybindings, findConflicts, applyKeybindings, acceleratorFromEvent, matchesAccelerator, formatAccelerator } = shortcuts;

test('Electron のキー名・修飾キーの別名と順序を同じ割り当てに正規化する', () => {
  for (const value of ['CmdOrCtrl+Shift+t', 'shift+cmd+t', 'CommandOrControl+Shift+T', 'Meta+Shift+T', 'Super+Shift+T']) assert.equal(normalizeAccelerator(value), 'Shift+Command+T');
  assert.equal(normalizeAccelerator('Option+Ctrl+Left'), 'Control+Alt+Left');
  assert.equal(normalizeAccelerator('Cmd+Return'), 'Command+Enter');
  assert.equal(normalizeAccelerator('Control+Esc'), 'Control+Escape');
  for (const key of ['F24', 'Space', 'PageDown', 'num0', 'numadd', 'MediaPlayPause', 'Backspace', 'Delete', '\\', "'", ',', '.', '/', '=']) assert.ok(isValidAccelerator(`Command+${key}`), key);
  assert.equal(normalizeAccelerator('Cmd+Plus'), 'Shift+Command+=');
  assert.equal(normalizeAccelerator('Command+{'), normalizeAccelerator('Cmd+Shift+['));
  assert.equal(normalizeAccelerator('Cmd+!'), normalizeAccelerator('Command+Shift+1'));
});

test('単独キー・修飾キーだけ・未知の名前・壊れた書式を受け付けない', () => {
  for (const value of [null, undefined, true, {}, [], 42, '', 'T', 'F1', 'Command', 'Command+Shift', 'Command+T+X', 'Command++', 'Cmd+Cmd+T', 'Cmd+Command+T', 'Command+Unknown', 'Command+F25', 'Command+あ', 'Command+ T', 'Command+T\n', 'constructor+T', '__proto__+T', 'Command+T\0']) assert.equal(isValidAccelerator(value), false, String(value));
});

test('すべてのメニュー操作に一意な ID があり、既定のキーに重なりがない', () => {
  const items = applyKeybindings();
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) {
    if (item.defaultAccelerator) assert.ok(isValidAccelerator(item.defaultAccelerator), item.id);
    if (!item.aliasFor && item.accelerator) assert.deepEqual(findConflicts(item.id, item.accelerator), [], item.id);
  }
});

test('上書き・解除・項目ごとの復元を適用し、既定と入力のオブジェクトを変えない', () => {
  const bindings = { new: 'Ctrl+Alt+T', close: null, 'find-prev': 'Control+Alt+G' };
  const snapshot = JSON.stringify(bindings);
  const items = new Map(applyKeybindings(bindings).map((item) => [item.id, item]));
  assert.equal(items.get('new').accelerator, 'Control+Alt+T');
  assert.equal(items.get('close').accelerator, null);
  assert.equal(items.get('find-prev').accelerator, 'Control+Alt+G');
  assert.equal(items.get('settings').accelerator, 'Command+,');
  assert.equal(acceleratorFor('new', {}), 'Command+T');
  assert.equal(JSON.stringify(bindings), snapshot);
  assert.equal(shortcuts.SHORTCUTS.find((item) => item.id === 'new').defaultAccelerator, 'Command+T');
});

test('文字拡大の隠れた別キーも、親の変更・解除・復元に従う', () => {
  assert.equal(acceleratorFor('font-bigger-plus'), 'Shift+Command+=');
  for (const value of [null, 'Command+F12']) {
    assert.equal(acceleratorFor('font-bigger-plus', { 'font-bigger': value }), null);
    assert.equal(applyKeybindings({ 'font-bigger': value }).find((item) => item.id === 'font-bigger-plus').accelerator, null);
  }
  assert.equal(acceleratorFor('font-bigger-plus', {}), 'Shift+Command+=');
  assert.equal(findConflicts('font-bigger', 'Command+Plus').length, 0);
  assert.equal(findConflicts('new', 'Command+Shift+=').at(0).id, 'font-bigger-plus');
});

test('既定・上書き・OS 標準・固定の入力キーとの重なりを判定する', () => {
  assert.equal(findConflicts('new', 'Command+Shift+G').at(0).id, 'toggle-git');
  assert.equal(findConflicts('new', 'Control+Alt+T', { close: 'Alt+Ctrl+T' }).at(0).id, 'close');
  assert.equal(findConflicts('new', 'Command+C').at(0).id, 'role-copy');
  assert.equal(findConflicts('new', 'Shift+Enter').at(0).id, 'terminal-newline');
  assert.deepEqual(findConflicts('new', 'Command+T'), []);
  assert.deepEqual(findConflicts('new', null), []);
  assert.deepEqual(findConflicts('new', 'Command+W', { close: null }), []);
  assert.match(validateKeybindings({ new: 'Command+W' }), /タブを閉じる/);
  assert.match(validateKeybindings({ new: 'Command+C' }), /コピー/);
  assert.equal(validateKeybindings({ new: 'Command+W', close: 'Command+T' }), null);
});

test('誤った値と重なる値だけを捨て、残りの上書きを使う', () => {
  for (const value of [null, false, 'text', [], 3]) assert.deepEqual(readKeybindings(value), { bindings: {}, invalid: true });
  const result = readKeybindings({ new: 'Control+Alt+T', close: null, save: false, unknown: 'Command+F10', 'role-copy': null, find: 'Command+W' });
  assert.deepEqual(result, { bindings: { new: 'Control+Alt+T', close: null, find: 'Command+W' }, invalid: true });
  assert.deepEqual(readKeybindings({ new: 'Command+W', close: 'Command+S', save: 'Command+C' }), { bindings: {}, invalid: true });
  assert.equal(validateKeybindings({ 'role-paste': null }) !== null, true);
  assert.equal(validateKeybindings({ 'font-bigger-plus': null }) !== null, true);
  assert.deepEqual(readKeybindings({}), { bindings: {}, invalid: false });
});

test('単一項目の復元で別の上書きと重なる場合も保存を拒む', () => {
  const bindings = { new: 'Control+Alt+T', close: 'Command+T' };
  assert.equal(validateKeybindings(bindings), null);
  const next = { ...bindings };
  delete next.new;
  assert.match(validateKeybindings(next), /新しいターミナル/);
  assert.equal(validateKeybindings({}), null);
});

test('DOM と Electron の入力を同じキーにし、Option の文字・Shift の記号を誤記録しない', () => {
  assert.equal(acceleratorFromEvent({ key: '†', code: 'KeyT', metaKey: true, altKey: true }), 'Alt+Command+T');
  assert.equal(acceleratorFromEvent({ key: '{', code: 'BracketLeft', meta: true, shift: true }), 'Shift+Command+[');
  assert.equal(acceleratorFromEvent({ key: 'Tab', control: true }), 'Control+Tab');
  assert.equal(acceleratorFromEvent({ key: '+', code: 'NumpadAdd', ctrlKey: true }), 'Control+numadd');
  assert.equal(matchesAccelerator({ key: 'y', code: 'KeyY', ctrlKey: true }, 'Ctrl+Y'), true);
  assert.equal(matchesAccelerator({ key: 'Tab', ctrlKey: true }, null), false);
  assert.equal(matchesAccelerator({ key: 'Tab', ctrlKey: true, repeat: true }, 'Control+Tab'), true);
  assert.equal(findConflicts('new', 'Control+Tab', { recent: null }).at(0).id, 'overview-cycle');
  for (const event of [{ key: 'T' }, { key: 'Meta', metaKey: true }, { key: 'Dead', altKey: true }, { key: 't', metaKey: true, isComposing: true }, { key: 't', metaKey: true, keyCode: 229 }]) assert.equal(acceleratorFromEvent(event), null);
});

test('表示に macOS の修飾キー・矢印・改行・解除を使う', () => {
  assert.equal(formatAccelerator('Ctrl+Option+Shift+Cmd+Left'), '⌃⌥⇧⌘←');
  assert.equal(formatAccelerator('Command+Return'), '⌘↩');
  assert.equal(formatAccelerator(null), '');
  assert.equal(formatAccelerator('Command+Plus'), '⇧⌘=');
});

test('ブラウザと Node.js で同じ検査と定義を使える', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shortcuts.js'), 'utf8'), context);
  assert.equal(context.terpShortcuts.normalizeAccelerator('Ctrl+Cmd+1'), 'Control+Command+1');
  assert.equal(JSON.stringify(context.terpShortcuts.applyKeybindings({ new: null })), JSON.stringify(applyKeybindings({ new: null })));
});

test('設定の読み書きで部分的な誤りを除去し、保存時は重なりを拒む', () => {
  const previous = process.env.TERP_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-shortcuts-'));
  process.env.TERP_CONFIG_DIR = dir;
  const config = require('./config');
  try {
    config.ensureConfigFile();
    assert.deepEqual(config.rawConfig().keybindings, {});
    assert.deepEqual(config.loadConfig().keybindings, {});
    config.updateConfig({ keybindings: { new: 'Control+Alt+T', close: null } });
    assert.deepEqual(config.loadConfig().keybindings, { new: 'Control+Alt+T', close: null });
    const before = fs.readFileSync(config.CONFIG_PATH, 'utf8');
    for (const value of [false, [], { new: 'T' }, { new: 'Command+C' }, { unknown: null }, { 'role-copy': null }]) assert.throws(() => config.updateConfig({ keybindings: value }));
    assert.equal(fs.readFileSync(config.CONFIG_PATH, 'utf8'), before);
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ keybindings: { new: 'Ctrl+Alt+T', close: 3, save: null }, fontSize: 18, custom: 'keep' }));
    assert.deepEqual(config.rawConfig().keybindings, { new: 'Control+Alt+T', save: null });
    assert.deepEqual(config.loadConfig().keybindings, { new: 'Control+Alt+T', save: null });
    assert.match(config.loadConfig().error, /keybindings/);
    config.updateConfig({ keybindings: {} });
    assert.equal(JSON.parse(fs.readFileSync(config.CONFIG_PATH)).custom, 'keep');
    assert.equal(config.loadConfig().font.size, 18);
    assert.equal(config.loadConfig().error, null);
    config.updateConfig({ keybindings: null });
    assert.deepEqual(config.loadConfig().keybindings, {});
  } finally {
    if (previous === undefined) delete process.env.TERP_CONFIG_DIR;
    else process.env.TERP_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
