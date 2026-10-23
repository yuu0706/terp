import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Unicode11Addon } from '../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';

const terp = window.terp;
const container = document.getElementById('terminals');
const list = document.getElementById('session-list');
const empty = document.getElementById('empty');
const configError = document.getElementById('config-error');

const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'fish', 'sh', 'login']);
const BUSY_MS = 2000;
// claude などが題名の前に付ける、作業中を表す回転の記号。✳ は入力待ち
const WORKING_MARKS = /^[◐◑◒◓⠁-⣿·✢✶✻✽*]/u;
// 題名が出る前の既定のタイトル。名前には使わない
const DEFAULT_TITLES = new Set(['Claude Code', 'Codex', 'codex', 'claude']);

// 端末のタイトル（OSC 0/2）を、先頭の記号と題名に分ける
function parseTitle(raw) {
  const m = raw.trim().match(/^([^\p{L}\p{N}]+)\s*(.*)$/u);
  const mark = m ? m[1].trim() : '';
  const text = (m ? m[2] : raw).trim();
  return { working: WORKING_MARKS.test(mark) && mark !== '✳', text: DEFAULT_TITLES.has(text) ? '' : text };
}

// 一覧の並び順どおりに持つ
const sessions = new Map();
let activeId = null;
// 最近表示した順。⌃Tab で直前へ戻るのに使う
let recent = [];
let config = await terp.getConfig();

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// 背景は奥の面（body の --surface-term）1枚で塗る。端末側でも塗ると、透過のときに2枚重なって濃くなる
function terminalTheme(c) {
  return { ...c.terminal, background: 'rgba(0, 0, 0, 0)' };
}

// 設定（色・フォント・透過）を、開いているすべての端末と枠に反映する
function applyConfig(c) {
  config = c;
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(c.chrome)) root.setProperty(`--color-${key}`, value);
  root.setProperty('--surface-term', withAlpha(c.chrome['term-bg'], c.window.opacity));
  root.setProperty('--surface-sidebar', withAlpha(c.chrome.bg, c.window.opacity));
  configError.textContent = c.error || '';
  configError.hidden = !c.error;
  for (const s of sessions.values()) {
    s.term.options.theme = terminalTheme(c);
    s.term.options.fontFamily = c.font.family;
    s.term.options.fontSize = c.font.size;
    if (!s.el.hidden) s.fit.fit();
  }
}

function shortPath(p) {
  if (!p) return '';
  return p === terp.home ? '~' : p.startsWith(terp.home + '/') ? '~' + p.slice(terp.home.length) : p;
}

function isAgent(s) {
  return Boolean(s.program) && !SHELLS.has(s.program);
}

// 名前の優先順: 自分で付けた名前 > claude などが作った題名 > 作業場所のフォルダ名
function displayName(s) {
  if (s.customName) return s.customName;
  if (isAgent(s) && s.agentTitle) return s.agentTitle;
  if (!s.cwd || s.cwd === terp.home) return '~';
  return s.cwd.split('/').pop();
}

function stateOf(s) {
  if (s.notify) return 'notify';
  if (isAgent(s) && s.agentWorking) return 'busy';
  if (Date.now() - s.lastOutput < BUSY_MS && s.lastOutput > s.createdAt + 1500) return 'busy';
  if (s.unread) return 'unread';
  return 'idle';
}

const STATE_LABELS = { busy: '出力中', unread: '未読の出力あり', notify: '通知あり', idle: '待機中' };

function renderItem(s) {
  const li = s.li;
  const index = [...sessions.keys()].indexOf(s.id);
  const state = stateOf(s);
  li.dataset.state = state;
  li.setAttribute('aria-current', String(s.id === activeId));
  li.title = [s.title, shortPath(s.cwd)].filter(Boolean).join('\n');
  li.querySelector('.session__dot').setAttribute('aria-label', STATE_LABELS[state]);
  const name = li.querySelector('.session__name');
  if (name) name.textContent = displayName(s);
  const program = isAgent(s) ? s.program : '';
  // 名前と同じ「~」を2行に重ねて出さない
  const place = shortPath(s.cwd) === displayName(s) ? '' : shortPath(s.cwd);
  li.querySelector('.session__sub').textContent = [program, place].filter(Boolean).join(' · ');
  li.querySelector('.session__key').textContent = index < 9 ? `⌘${index + 1}` : '';
}

function renderAll() {
  for (const s of sessions.values()) renderItem(s);
  empty.hidden = sessions.size > 0;
}

function createItem(s) {
  const li = document.createElement('li');
  li.className = 'session';
  li.innerHTML = `
    <span class="session__dot" role="img"></span>
    <span class="session__name"></span>
    <span class="session__key"></span>
    <span class="session__sub"></span>
    <button class="session__close" type="button" aria-label="閉じる" title="閉じる（⌘W）">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>`;
  li.addEventListener('click', () => activate(s.id));
  li.querySelector('.session__close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(s.id);
  });
  li.addEventListener('dblclick', (e) => {
    if (e.target.closest('.session__close')) return;
    startRename(s);
  });
  list.appendChild(li);
  return li;
}

function startRename(s) {
  const name = s.li.querySelector('.session__name');
  if (!name) return;
  const input = document.createElement('input');
  input.className = 'session__rename';
  input.value = displayName(s);
  input.setAttribute('aria-label', '名前');
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) s.customName = input.value.trim() || null;
    const span = document.createElement('span');
    span.className = 'session__name';
    input.replaceWith(span);
    renderItem(s);
    s.term.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// WebGL の描画は同時に持てる数に上限があるため、表示中の端末にだけ付ける
function attachWebgl(s) {
  if (s.webgl) return;
  try {
    s.webgl = new WebglAddon();
    s.webgl.onContextLoss(() => detachWebgl(s));
    s.term.loadAddon(s.webgl);
  } catch {
    s.webgl = null;
  }
}

function detachWebgl(s) {
  s.webgl?.dispose();
  s.webgl = null;
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  const prev = sessions.get(activeId);
  if (prev && prev !== s) {
    prev.el.hidden = true;
    detachWebgl(prev);
  }
  activeId = id;
  recent = [id, ...recent.filter((r) => r !== id)];
  s.el.hidden = false;
  s.unread = false;
  s.notify = false;
  attachWebgl(s);
  s.fit.fit();
  s.term.focus();
  renderAll();
  s.li.scrollIntoView({ block: 'nearest' });
}

function handleKey(s, event) {
  if (event.type !== 'keydown') return true;
  // claude の改行。VS Code の /terminal-setup と同じく ESC + CR を送る
  if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    terp.write(s.id, '\x1b\r');
    return false;
  }
  if (event.key === 'Tab' && event.ctrlKey) {
    event.preventDefault();
    switchRecent();
    return false;
  }
  // ⌘ の付くキーはメニュー（main.js）が受け取る
  return !event.metaKey;
}

async function openTerminal({ cwd } = {}) {
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  container.appendChild(el);

  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    fontFamily: config.font.family,
    fontSize: config.font.size,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    theme: terminalTheme(config),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_event, url) => terp.openExternal(url)));
  term.open(el);

  // 寸法を測れるよう、一度表示してから疑似端末を作る
  el.hidden = false;
  fit.fit();
  const { id, cwd: startCwd } = await terp.createPty({ cols: term.cols, rows: term.rows, cwd });
  const s = {
    id,
    term,
    fit,
    el,
    cwd: startCwd,
    program: '',
    title: '',
    customName: null,
    agentTitle: '',
    agentWorking: false,
    createdAt: Date.now(),
    lastOutput: 0,
    unread: false,
    notify: false,
    webgl: null,
  };
  sessions.set(id, s);
  s.li = createItem(s);

  term.attachCustomKeyEventHandler((event) => handleKey(s, event));
  term.onData((data) => terp.write(id, data));
  term.onResize(({ cols, rows }) => terp.resize(id, cols, rows));
  term.onTitleChange((title) => {
    s.title = title;
    const { working, text } = parseTitle(title);
    if (text) s.agentTitle = text;
    // 作業中から入力待ちに変わったら、応答が終わったことを知らせる
    if (s.agentWorking && !working) markNotify(s);
    s.agentWorking = working;
    renderItem(s);
  });
  term.onBell(() => markNotify(s));
  // OSC 9 / 777 は claude などが「入力待ち」を知らせるのに使う
  term.parser.registerOscHandler(9, () => (markNotify(s), true));
  term.parser.registerOscHandler(777, () => (markNotify(s), true));
  new ResizeObserver(() => {
    if (!el.hidden) fit.fit();
  }).observe(el);

  activate(id);
  return s;
}

function markNotify(s) {
  if (s.id === activeId && document.hasFocus()) return;
  s.notify = true;
  renderItem(s);
}

function closeSession(id) {
  terp.kill(id);
}

function removeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const order = [...sessions.keys()];
  const index = order.indexOf(id);
  detachWebgl(s);
  s.term.dispose();
  s.el.remove();
  s.li.remove();
  sessions.delete(id);
  recent = recent.filter((r) => r !== id);
  if (activeId === id) {
    activeId = null;
    const next = recent[0] ?? order[index + 1] ?? order[index - 1];
    if (next !== undefined && sessions.has(next)) activate(next);
  }
  renderAll();
}

function switchRecent() {
  if (recent.length > 1) activate(recent[1]);
}

function switchOffset(offset) {
  const order = [...sessions.keys()];
  if (order.length === 0) return;
  const index = order.indexOf(activeId);
  activate(order[(index + offset + order.length) % order.length]);
}

function newTerminal() {
  return openTerminal({ cwd: sessions.get(activeId)?.cwd });
}

terp.onData((id, data) => {
  const s = sessions.get(id);
  if (!s) return;
  s.term.write(data);
  s.lastOutput = Date.now();
  if (id !== activeId) s.unread = true;
});

terp.onExit((id) => removeSession(id));
terp.onConfig(applyConfig);

terp.onInfo((info) => {
  for (const { id, cwd, program } of info) {
    const s = sessions.get(id);
    if (!s) continue;
    s.cwd = cwd;
    s.program = program;
  }
  renderAll();
});

terp.onMenu((action, arg) => {
  const s = sessions.get(activeId);
  switch (action) {
    case 'new':
      newTerminal();
      break;
    case 'close':
      if (s) closeSession(s.id);
      break;
    case 'clear':
      s?.term.clear();
      break;
    case 'select-all':
      if (document.activeElement?.tagName === 'INPUT') document.execCommand('selectAll');
      else s?.term.selectAll();
      break;
    case 'select-index': {
      const id = [...sessions.keys()][arg];
      if (id !== undefined) activate(id);
      break;
    }
    case 'recent':
      switchRecent();
      break;
    case 'prev':
      switchOffset(-1);
      break;
    case 'next':
      switchOffset(1);
      break;
  }
});

document.getElementById('new-terminal').addEventListener('click', () => newTerminal());
document.getElementById('empty-new').addEventListener('click', () => newTerminal());

// 出力中の印を時間で消すため、状態だけ定期的に描き直す
setInterval(renderAll, 500);

// 自己診断（TERP_SELFTEST）から操作するための口
window.__terp = {
  sessions,
  get activeId() {
    return activeId;
  },
  open: (cwd) => openTerminal({ cwd }).then((s) => s.id),
  activate,
  get config() {
    return config;
  },
  bufferText(id) {
    const buf = sessions.get(id).term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
    return lines.join('\n').replace(/\n+$/, '');
  },
};

applyConfig(config);
openTerminal();
