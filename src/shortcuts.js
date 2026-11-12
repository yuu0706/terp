// 本体と画面で同じ検査を使うため、Electron・DOM に依存させない。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.terpShortcuts = api;
})(globalThis, function () {
  const command = (id, label, accelerator = null, extra = {}) => ({ id, label, defaultAccelerator: accelerator, action: id, editable: true, ...extra });
  // role のキーを上書きすると、macOS の標準編集・アプリ操作と食い違うため表示だけにする。
  const role = (name, label, accelerator = null) => ({ id: `role-${name}`, role: name, label, defaultAccelerator: accelerator, editable: false });
  const separator = () => ({ type: 'separator' });
  const MENU_GROUPS = [
    { label: 'terp', role: 'appMenu', items: [
      role('about', 'terp について'), separator(),
      command('settings', '設定…', 'Command+,'), command('open-config', '設定ファイルを開く'), separator(),
      role('hide', 'terp を隠す', 'Command+H'), role('hideOthers', 'ほかを隠す', 'Command+Alt+H'), role('unhide', 'すべて表示'), separator(), role('quit', 'terp を終了', 'Command+Q'),
    ] },
    { label: 'ターミナル', items: [
      command('new', '新しいターミナル', 'Command+T'), command('split-right', '右に分割', 'Command+\\'),
      command('reopen', '閉じたタブを開き直す', 'Command+Shift+T'), command('new-work', '新しい作業…', 'Command+N'),
      command('add-project', 'リポジトリを追加…'), command('close', 'タブを閉じる', 'Command+W'), command('save', '保存', 'Command+S'), separator(), command('clear', '画面を消去', 'Command+K'),
    ] },
    { label: 'ワークスペース', items: [
      ...Array.from({ length: 9 }, (_, i) => command(`workspace-${i + 1}`, `ワークスペース ${i + 1}`, `Control+Command+${i + 1}`, { action: 'workspace-index', arg: i })), separator(),
      command('workspace-next', '次のワークスペース', 'Control+Command+]'), command('workspace-prev', '前のワークスペース', 'Control+Command+['),
    ] },
    { label: '編集', items: [
      role('copy', 'コピー', 'Command+C'), role('paste', '貼り付け', 'Command+V'), command('select-all', 'すべて選択', 'Command+A'), separator(),
      command('find', '検索', 'Command+F'), command('find-next', '次を検索', 'Command+G'), command('find-prev', '前を検索'),
    ] },
    { label: '移動', items: [
      command('overview', '全体の一覧', 'Command+M'),
      // ⌃Tab は端末が先に受けるため、変更後のキーも画面側で扱う。
      command('recent', '直前のタブ', 'Control+Tab', { registerAccelerator: false }),
      command('prev', '前のタブ', 'Command+Shift+['), command('next', '次のタブ', 'Command+Shift+]'), command('next-attention', '次の要対応', 'Command+Shift+J'), separator(),
      command('pane-left', '左の枠', 'Command+Alt+Left'), command('pane-right', '右の枠', 'Command+Alt+Right'), command('pane-up', '上の枠', 'Command+Alt+Up'), command('pane-down', '下の枠', 'Command+Alt+Down'), command('toggle-lock', '今の枠を固定'), separator(),
      ...Array.from({ length: 9 }, (_, i) => command(`tab-${i + 1}`, `タブ ${i + 1}`, `Command+${i + 1}`, { action: 'select-index', arg: i })),
    ] },
    { label: '表示', items: [
      command('toggle-sidebar', '左の一覧', 'Command+B'), command('toggle-files', 'ファイル', 'Command+Shift+E'), command('toggle-git', '変更の一覧', 'Command+Shift+G'), command('toggle-history', '履歴', 'Command+Shift+H'), separator(),
      command('font-bigger', '文字を大きく', 'Command+='),
      // 既定の別名だけを残すと解除・変更後も動いてしまうため、親を上書きしたら別名も外す。
      command('font-bigger-plus', '文字を大きく（＋）', 'Command+Plus', { aliasFor: 'font-bigger', action: 'font-bigger', visible: false, editable: false }),
      command('font-smaller', '文字を小さく', 'Command+-'), command('font-reset', '文字を元の大きさに', 'Command+0'), separator(),
      command('check-screen', 'ターミナルの表示を検査'), command('redraw-terminal', 'ターミナルの表示を作り直す'), command('replace-host', '常駐のプロセスを入れ替える…'), separator(),
      role('toggleDevTools', '開発者ツール', 'Command+Alt+I'), role('togglefullscreen', 'フルスクリーン', 'Control+Command+F'),
    ] },
  ];
  const SHORTCUTS = MENU_GROUPS.flatMap((group) => group.items.filter((item) => item.id).map((item) => ({ ...item, group: group.label })));
  // 文脈に依存するキーはメニューへ移すと入力を壊すため、予約して一覧では参照だけにする。
  const FIXED_SHORTCUTS = [
    ['terminal-newline', '端末で改行', 'Shift+Enter'], ['word-left', '端末で前の単語へ', 'Alt+Left'], ['word-right', '端末で次の単語へ', 'Alt+Right'],
    ['line-start', '端末で行の頭へ', 'Command+Left'], ['line-end', '端末で行の末尾へ', 'Command+Right'], ['line-delete', '端末で行の頭まで消す', 'Command+Backspace'],
    ['repo-up', 'リポジトリを上へ並べ替え', 'Alt+Up'], ['repo-down', 'リポジトリを下へ並べ替え', 'Alt+Down'],
    ['markdown-preview', 'Markdown の表示を切り替え', 'Command+Shift+V'], ['git-commit', 'コミット欄でコミット', 'Command+Enter'],
  ].map(([id, label, defaultAccelerator]) => ({ id, label, defaultAccelerator, editable: false, group: '画面内の操作' }));
  FIXED_SHORTCUTS.push({ id: 'overview-cycle', label: '全体の一覧でまとまりを切り替え', defaultAccelerator: 'Control+Tab', editable: false, group: '画面内の操作', sharesWith: 'recent' });
  const ALL_SHORTCUTS = [...SHORTCUTS, ...FIXED_SHORTCUTS];
  const byId = new Map(SHORTCUTS.map((item) => [item.id, item]));
  const MODIFIERS = { command: 'Command', cmd: 'Command', commandorcontrol: 'Command', cmdorctrl: 'Command', control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift', super: 'Command', meta: 'Command' };
  const ORDER = ['Control', 'Alt', 'AltGr', 'Shift', 'Command'];
  const KEY_NAMES = ['Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `num${i}`)];
  const keys = new Map(KEY_NAMES.map((key) => [key.toLowerCase(), key]));
  const SHIFTED = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };

  function normalizeAccelerator(value) {
    if (typeof value !== 'string' || !value || value.length > 120 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
    const parts = value.split('+');
    // Electron は + 自体を Plus と書く。空のトークンは誤記として扱う。
    if (parts.some((part) => !part) || parts.length < 2) return null;
    const rawKey = parts.pop();
    const modifiers = new Set();
    for (const part of parts) {
      const modifier = Object.hasOwn(MODIFIERS, part.toLowerCase()) ? MODIFIERS[part.toLowerCase()] : null;
      if (!modifier || modifiers.has(modifier)) return null;
      modifiers.add(modifier);
    }
    let key = keys.get(rawKey.toLowerCase()) || (/^[a-z0-9`\-=\[\]\\;',./!@#$%^&*()_{}|:"<>?~]$/i.test(rawKey) ? rawKey.toUpperCase() : null);
    if (!key) return null;
    if (key === 'Plus') key = '+';
    if (key === 'Return') key = 'Enter';
    if (key === 'Esc') key = 'Escape';
    if (SHIFTED[key]) { key = SHIFTED[key]; modifiers.add('Shift'); }
    return [...ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
  }

  function isValidAccelerator(value) { return normalizeAccelerator(value) !== null; }

  function acceleratorFor(id, bindings = {}) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) bindings = {};
    const item = byId.get(id) || FIXED_SHORTCUTS.find((entry) => entry.id === id);
    if (!item) return null;
    if (item.aliasFor && Object.hasOwn(bindings, item.aliasFor)) return null;
    if (item.editable && Object.hasOwn(bindings, id)) return bindings[id] === null ? null : normalizeAccelerator(bindings[id]) || normalizeAccelerator(item.defaultAccelerator);
    return normalizeAccelerator(item.defaultAccelerator);
  }

  function findConflicts(id, accelerator, bindings = {}) {
    const normalized = normalizeAccelerator(accelerator);
    if (!normalized) return [];
    return ALL_SHORTCUTS.filter((item) => item.id !== id && item.aliasFor !== id && item.sharesWith !== id && acceleratorFor(item.id, bindings) === normalized);
  }

  function readKeybindings(value) {
    const bindings = {};
    let invalid = !value || typeof value !== 'object' || Array.isArray(value);
    if (!invalid) for (const [id, accelerator] of Object.entries(value)) {
      if (!byId.get(id)?.editable || (accelerator !== null && !isValidAccelerator(accelerator))) { invalid = true; continue; }
      bindings[id] = accelerator === null ? null : normalizeAccelerator(accelerator);
    }
    // ファイルを手で直した場合も、重なる上書きだけを捨てる。既定へ戻した結果の重なりも解消する。
    let rejected;
    do {
      rejected = Object.keys(bindings).filter((id) => bindings[id] !== null && findConflicts(id, bindings[id], bindings).length);
      for (const id of rejected) delete bindings[id];
      if (rejected.length) invalid = true;
    } while (rejected.length);
    return { bindings, invalid };
  }

  function validateKeybindings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'ショートカットは操作ごとのキーで指定する';
    for (const [id, accelerator] of Object.entries(value)) {
      if (!byId.get(id)?.editable) return `変更できない操作: ${id}`;
      if (accelerator !== null && !isValidAccelerator(accelerator)) return `${byId.get(id).label}: 修飾キーと組み合わせて指定する`;
      const conflicts = findConflicts(id, accelerator, value);
      if (conflicts.length) return `${byId.get(id).label}: ${conflicts.map((item) => item.label).join('・')} と重なる。別のキーを選ぶ`;
    }
    return null;
  }

  function applyKeybindings(bindings = {}) {
    const clean = readKeybindings(bindings).bindings;
    return SHORTCUTS.map((item) => ({ ...item, accelerator: acceleratorFor(item.id, clean) }));
  }

  const CODE_KEYS = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
  function acceleratorFromEvent(event) {
    if (event.isComposing || event.keyCode === 229 || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return null;
    const modifiers = [event.ctrlKey || event.control ? 'Control' : '', event.altKey || event.alt ? 'Alt' : '', event.shiftKey || event.shift ? 'Shift' : '', event.metaKey || event.meta ? 'Command' : ''].filter(Boolean);
    const code = event.code || '';
    let key = CODE_KEYS[code] || (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : null);
    if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
    key = ({ NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' })[code] || key;
    key = key || ({ ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' })[event.key] || event.key;
    return normalizeAccelerator([...modifiers, key].join('+'));
  }

  function matchesAccelerator(event, accelerator) {
    const normalized = normalizeAccelerator(accelerator);
    return normalized !== null && acceleratorFromEvent(event) === normalized;
  }

  function formatAccelerator(accelerator) {
    const normalized = normalizeAccelerator(accelerator);
    if (!normalized) return '';
    const parts = normalized.split('+');
    const key = parts.pop();
    const symbols = { Control: '⌃', Alt: '⌥', AltGr: '⌥', Shift: '⇧', Command: '⌘' };
    const names = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Space: 'スペース', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘' };
    return parts.map((part) => symbols[part]).join('') + (names[key] || key);
  }

  return { MENU_GROUPS, SHORTCUTS, FIXED_SHORTCUTS, ALL_SHORTCUTS, normalizeAccelerator, isValidAccelerator, acceleratorFor, findConflicts, readKeybindings, validateKeybindings, applyKeybindings, acceleratorFromEvent, matchesAccelerator, formatAccelerator };
});
