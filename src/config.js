// 設定ファイル（~/.config/terp/config.json）とテーマの読み込み
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.TERP_CONFIG_DIR || path.join(os.homedir(), '.config', 'terp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// テーマを探す場所。先に見つかったものを使う
const THEME_DIRS = [
  path.join(CONFIG_DIR, 'themes'),
  path.join(os.homedir(), '.config', 'ghostty', 'themes'),
  '/Applications/Ghostty.app/Contents/Resources/ghostty/themes',
];

const DEFAULT_CONFIG = {
  theme: null,
  accent: null,
  // テーマの色の上書き。null ならテーマの色を使う。palette は { "0": "#rrggbb", … "15": … } の一部だけでもよい
  foreground: null,
  background: null,
  // アプリの地（左の一覧・窓の周り）の色。null ならターミナルの背景色から作る
  appBackground: null,
  // appBackground を AI のテーマと一緒に作ったときの、そのテーマの名前。別のテーマのときは appBackground を使わない
  appBackgroundTheme: null,
  palette: null,
  fontFamily: '"JetBrains Mono", Menlo, "Hiragino Sans", monospace',
  fontSize: 14,
  paddingX: 10,
  paddingY: 8,
  minimumContrast: 1,
  cursorStyle: 'block',
  cursorBlink: false,
  // 背景の不透明度（0〜1）とぼかし（true か半径）。Ghostty の background-opacity・background-blur に当たる
  backgroundOpacity: 1,
  backgroundBlur: false,
  // AI エージェントの上書きと追加。配列の順に並べる。
  // { command, label, args, bypassArgs, path（絶対パス）, env（名前と値）, hidden }
  agents: [],
  // true なら、エージェントを確認なし（bypassArgs 付き）で起動する。⌥ を押しながらで逆になる
  skipApprovals: false,
  // タブの並びの隣のボタンで、プルダウンなしで起動するエージェントの command。null なら見つかった最初のもの
  mainAgent: null,
  // 新しいタブのプルダウンに出す、利用者が決めたコマンド。配列の順に並べる。{ label（表示名）, command（シェルに打つ1行） }
  commands: [],
  notifications: true,
  dockBadge: true,
  themedIcon: true,
  notifyAgentDone: true,
  notifyBell: true,
  notifyWhenVisible: false,
  notifySound: true,
  notifyMessage: true,
  // 表示していないエージェントの許可待ちを、右下のカードから移らずに答えられるようにする
  permissionCard: true,
  // AI の手伝い。aiAssist で全体を切り、機能ごとにも切れる。aiAutoTitle は画面の文字を claude に送るため既定で切る。
  // aiDailyLimit は1日に claude を呼ぶ回数の上限（0 なら上限なし）
  aiAssist: true,
  aiModel: 'haiku',
  aiCommitMessage: true,
  aiNameTerminal: true,
  aiAutoTitle: false,
  aiDailyLimit: 30,
  // ドラフトから外すときに確認するか。確認の画面の「今後は確認しない」で切れる
  confirmDraftRemove: true,
};

// テーマを指定しないときの色（Catppuccin Mocha 相当）
const BUILTIN_THEME = {
  palette: [
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
  ],
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorText: '#1e1e2e',
  selectionBackground: '#585b70',
  selectionForeground: '#cdd6f4',
};

// Ghostty のテーマの書式（palette = N=#hex、background = #hex など）を読む
function parseGhosttyTheme(text) {
  const theme = { palette: [...BUILTIN_THEME.palette] };
  const keys = {
    background: 'background',
    foreground: 'foreground',
    'cursor-color': 'cursor',
    'cursor-text': 'cursorText',
    'selection-background': 'selectionBackground',
    'selection-foreground': 'selectionForeground',
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'palette') {
      const m = value.match(/^(\d+)\s*=\s*(#?[0-9a-fA-F]{6})$/);
      if (m && Number(m[1]) < 16) theme.palette[Number(m[1])] = normalizeHex(m[2]);
    } else if (keys[key]) {
      theme[keys[key]] = normalizeHex(value);
    }
  }
  return { ...BUILTIN_THEME, ...theme };
}

function normalizeHex(value) {
  return value.startsWith('#') ? value : `#${value}`;
}

function findTheme(name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('テーマの名前が正しくありません');
  }
  for (const dir of THEME_DIRS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function mix(a, b, ratio) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * ratio);
  };
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

function contrastRatio(a, b) {
  const luminance = (hex) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return r * 0.2126 + g * 0.7152 + b2 * 0.0722;
  };
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// 候補を順に見て、地の色とのコントラスト比が 4.5 以上の最初の色。無ければいちばん見分けやすい色
function readableOn(base, candidates) {
  return candidates.find((c) => contrastRatio(c, base) >= 4.5)
    || candidates.reduce((a, b) => (contrastRatio(b, base) > contrastRatio(a, base) ? b : a));
}

// 端末の色から、左の一覧などアプリの枠の色を作る
// アプリの背景色（appBackground）を決めていれば、地の色をそれにし、行の強調・枠・薄い文字もその色から作る。
// 決めていなければ、ターミナルの背景色を少し暗くして地の色にする
function chromeColors(t, accent) {
  const base = t.appBackground || t.background;
  // アプリの背景色をテーマと別に決めると、暗いテーマの白い文字が明るい地に乗って読めなくなる（2026-10-29 利用者の指摘）。
  // 地の色と見分けにくければ、読める色に替える
  const text = readableOn(base, [t.foreground, t.background, '#000000', '#ffffff']);
  return {
    'term-bg': t.background,
    bg: t.appBackground || mix(t.background, '#000000', 0.2),
    'bg-hover': mix(base, text, 0.07),
    'bg-active': mix(base, text, 0.14),
    border: mix(base, text, 0.14),
    text,
    'text-muted': mix(text, base, 0.35),
    accent,
    busy: t.palette[2],
    warning: t.palette[3],
    danger: t.palette[1],
  };
}

function xtermTheme(t) {
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const theme = {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorText,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
  };
  names.forEach((name, i) => {
    theme[name] = t.palette[i];
    theme[`bright${name[0].toUpperCase()}${name.slice(1)}`] = t.palette[i + 8];
  });
  return theme;
}

// 強調色の既定はカーソルの色。テーマの印象をいちばんよく表すため
function themeColors(theme, accent = rawConfig().accent) {
  return { terminal: xtermTheme(theme), chrome: chromeColors(theme, accent || theme.cursor || theme.palette[4]) };
}

function readTheme(name) {
  if (name === null || name === undefined) return BUILTIN_THEME;
  const file = findTheme(name);
  if (!file) throw new Error(`テーマ「${name}」が見つかりません`);
  return parseGhosttyTheme(fs.readFileSync(file, 'utf8'));
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_VALIDATORS = {
  foreground: (v) => typeof v === 'string' && HEX_COLOR.test(v),
  background: (v) => typeof v === 'string' && HEX_COLOR.test(v),
  appBackground: (v) => typeof v === 'string' && HEX_COLOR.test(v),
  palette: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Object.entries(v).every(([i, c]) => /^(\d|1[0-5])$/.test(i) && typeof c === 'string' && HEX_COLOR.test(c)),
};

// 設定の文字色・背景色・16色を、テーマの色の上に重ねる（2026-10-28 利用者の指示。テーマを替えずに文字色を変えたい）。
// 誤った値は使わず、error に書いて返す
function applyColorOverrides(theme, config) {
  const next = { ...theme, palette: [...theme.palette] };
  let error = null;
  for (const [key, valid] of Object.entries(COLOR_VALIDATORS)) {
    const value = config[key];
    if (value === null || value === undefined) continue;
    if (!valid(value)) {
      error = error || `${key} の値を確認する。テーマの色で動作中`;
      continue;
    }
    if (key === 'palette') for (const [i, c] of Object.entries(value)) next.palette[Number(i)] = c.toLowerCase();
    else next[key] = value.toLowerCase();
  }
  return { theme: next, error };
}

// アプリの背景色は、決めたときのテーマ（appBackgroundTheme。既定のテーマは空の文字）のときだけ使う。別のテーマに替えたらテーマの色から作る。
// 以前は手で決めた色をどのテーマでも使っていたが、テーマを変えても一覧と設定の画面が変わらない不具合に見えた（2026-10-29 利用者の指摘）。
// 印の無い古い値も同じ理由で使わない
function overridesFor(config, name) {
  return config.appBackgroundTheme == null || config.appBackgroundTheme !== (name || '') ? { ...config, appBackground: null } : config;
}

// テーマの一覧の見本。上書きも重ねて、選んだ後と同じ色で見せる
function getThemeColors(name) {
  return themeColors(applyColorOverrides(readTheme(name), overridesFor(rawConfig(), name)).theme);
}

function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
}

const TERMINAL_VALIDATORS = {
  paddingX: (v) => Number.isInteger(v) && v >= 0 && v <= 40,
  paddingY: (v) => Number.isInteger(v) && v >= 0 && v <= 40,
  minimumContrast: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 21,
  cursorStyle: (v) => ['block', 'bar', 'underline'].includes(v),
  cursorBlink: (v) => typeof v === 'boolean',
  themedIcon: (v) => typeof v === 'boolean',
  appBackgroundTheme: (v) => v === null || (typeof v === 'string' && v.length <= 200),
  aiAssist: (v) => typeof v === 'boolean',
  aiModel: (v) => ['haiku', 'sonnet'].includes(v),
  aiCommitMessage: (v) => typeof v === 'boolean',
  aiNameTerminal: (v) => typeof v === 'boolean',
  aiAutoTitle: (v) => typeof v === 'boolean',
  aiDailyLimit: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
};

function normalizeTerminalConfig(config) {
  let error = null;
  for (const [key, valid] of Object.entries(TERMINAL_VALIDATORS)) {
    if (valid(config[key])) continue;
    config[key] = DEFAULT_CONFIG[key];
    error = error || `${key} の値を確認する。既定の値で動作中`;
  }
  return error;
}

// 読めないときは error を付けて既定の値で返す。画面はその error を表示する
function loadConfig() {
  let user = {};
  let error = null;
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') error = `config.json を読めません: ${err.message}`;
  }
  const config = { ...DEFAULT_CONFIG, ...user };
  const terminalError = normalizeTerminalConfig(config);
  error = error || terminalError;

  let theme = BUILTIN_THEME;
  try {
    theme = readTheme(config.theme);
  } catch (err) {
    error = error || err.message;
  }
  const overridden = applyColorOverrides(theme, overridesFor(config, config.theme));
  theme = overridden.theme;
  error = error || overridden.error;
  return {
    error,
    font: { family: config.fontFamily, size: config.fontSize },
    paddingX: config.paddingX,
    paddingY: config.paddingY,
    minimumContrast: config.minimumContrast,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
    window: {
      opacity: Math.min(1, Math.max(0.2, Number(config.backgroundOpacity) || 1)),
      // true は Ghostty と同じく半径 20。数値ならその半径
      blur: config.backgroundBlur === true ? 20 : Math.max(0, Math.min(100, Number(config.backgroundBlur) || 0)),
    },
    ...themeColors(theme, config.accent),
    agents: Array.isArray(config.agents) ? config.agents : [],
    skipApprovals: config.skipApprovals === true,
    mainAgent: typeof config.mainAgent === 'string' ? config.mainAgent : null,
    commands: readCommands(config.commands),
    notifications: config.notifications === true,
    dockBadge: config.dockBadge !== false,
    themedIcon: config.themedIcon !== false,
    notifyAgentDone: config.notifyAgentDone === true,
    notifyBell: config.notifyBell === true,
    notifyWhenVisible: config.notifyWhenVisible === true,
    notifySound: config.notifySound === true,
    notifyMessage: config.notifyMessage === true,
    permissionCard: config.permissionCard !== false,
    confirmDraftRemove: config.confirmDraftRemove !== false,
    ai: {
      enabled: config.aiAssist,
      commitMessage: config.aiAssist && config.aiCommitMessage,
      nameTerminal: config.aiAssist && config.aiNameTerminal,
      autoTitle: config.aiAssist && config.aiAutoTitle,
    },
  };
}

function watchConfig(onChange) {
  let timer = null;
  // エディタは保存のときにファイルを置き換えることがあるため、フォルダごと見る
  fs.watch(CONFIG_DIR, (_event, filename) => {
    // 同じフォルダの projects.json の書き換えでは読み直さない
    if (filename && filename !== 'config.json') return;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(loadConfig()), 150);
  });
}

function validateAgents(agents) {
  if (!Array.isArray(agents)) throw new Error('エージェントは一覧で指定する');
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new Error('エージェントの項目を確認する');
    for (const key of ['command', 'label', 'args', 'bypassArgs', 'path']) {
      if (agent[key] !== undefined && typeof agent[key] !== 'string') throw new Error(`${key} は文字で指定する`);
      if (typeof agent[key] === 'string' && /[\0\r\n]/.test(agent[key])) throw new Error(`${key} は1行で指定する`);
    }
    if (agent.path && !path.isAbsolute(agent.path)) throw new Error('コマンドの場所は絶対パスで指定する');
    if (agent.hidden !== undefined && typeof agent.hidden !== 'boolean') throw new Error('表示の設定を確認する');
    if (agent.env !== undefined) {
      if (!agent.env || typeof agent.env !== 'object' || Array.isArray(agent.env)) throw new Error('環境変数は名前と値で指定する');
      for (const [key, value] of Object.entries(agent.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('環境変数の名前は半角英数字と _ を使い、数字で始めない');
        if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('環境変数の値は1行の文字で指定する');
      }
    }
  }
}

// 名前とコマンドがそろった項目だけを使う。手で書いて誤った項目は飛ばし、ほかは使えるようにする
function readCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter((c) => c && ['label', 'command'].every((key) => typeof c[key] === 'string' && c[key].trim() && !/[\0\r\n]/.test(c[key])))
    .map((c) => ({ label: c.label.trim(), command: c.command.trim() }));
}

function validateCommands(commands) {
  if (!Array.isArray(commands)) throw new Error('コマンドは一覧で指定する');
  for (const c of commands) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('コマンドの項目を確認する');
    for (const [key, name] of [['label', '表示名'], ['command', 'コマンド']]) {
      if (typeof c[key] !== 'string' || !c[key].trim()) throw new Error(`コマンドの${name}を入れる`);
      if (/[\0\r\n]/.test(c[key])) throw new Error(`コマンドの${name}は1行で指定する`);
    }
  }
}

// 設定の画面から1つ以上の値を書き換える。null は「書かない（既定に戻す）」として消す。
// 画面に無い値や、利用者が手で書いた値は残す。JSON が壊れているときは書かずに失敗を返す
function updateConfig(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json が壊れているため書けません。直してから変えてください（${err.message}）`);
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`知らない設定の名前です: ${key}`);
    if (value === null) delete next[key];
    else {
      if (key === 'agents') validateAgents(value);
      if (key === 'commands') validateCommands(value);
      if (TERMINAL_VALIDATORS[key] && !TERMINAL_VALIDATORS[key](value)) throw new Error(`${key} の値を確認する`);
      if (COLOR_VALIDATORS[key] && !COLOR_VALIDATORS[key](value)) throw new Error(`${key} は #rrggbb の色で指定する`);
      next[key] = value;
    }
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

// 設定の画面に出す、いま書いてある値（既定の値を足したもの）
function rawConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // 読めないときは既定の値を出す。画面の警告は loadConfig の error が出す
  }
  const config = { ...DEFAULT_CONFIG, ...user };
  normalizeTerminalConfig(config);
  return config;
}

// 選べるテーマの名前。探す場所の順に並べ、同じ名前は先に見つかった方だけ
function listThemes() {
  const names = new Set();
  for (const dir of THEME_DIRS) {
    try {
      for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
        if (!name.startsWith('.')) names.add(name);
      }
    } catch {
      // 無い場所は飛ばす
    }
  }
  return [...names];
}

module.exports = { CONFIG_DIR, CONFIG_PATH, ensureConfigFile, loadConfig, watchConfig, parseGhosttyTheme, updateConfig, rawConfig, listThemes, getThemeColors, themeColors, applyColorOverrides, chromeColors, contrastRatio };
