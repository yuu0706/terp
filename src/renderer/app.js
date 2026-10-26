import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Unicode11Addon } from '../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { initHistoryPanel, setHistoryVisible, refreshHistory, filterFileHistory, renderCommitView } from './historypanel.js';
import { initGitPanel, refresh as refreshGit, setGitVisible } from './gitpanel.js';
import { initFilesPanel, refreshFiles, setFilesVisible, markActiveFile } from './filespanel.js';
import { renderFileView, applyEditorConfig } from './fileview.js';
import { createPathLinkProvider } from './pathlinks.js';
import { initSettings, openSettings, applySettingsConfig, agentIcon } from './settings.js';
import { createPane, paneList, splitPane, closePane, replacePane, restoreLayout, createPaneView, makeTabDraggable, paneTitle, MAX_PANES } from './panes.js';
import { terminalPaths, pathDropTarget, pathsFromTransfer } from './droppaths.js';
import { withAlpha, favoriteText } from './favcolor.js';
import { STAR_ICON, favoriteLabel, createMenu, createWorkspaceUI } from './workspaceui.js';
import { createOverview } from './overview.js';

const terp = window.terp;
// 枠の外でも Finder のファイルで窓が遷移しないよう、既定の動作を止める。
for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
}, true);
const container = document.getElementById('terminals');
const projectsEl = document.getElementById('projects');
const looseSection = document.getElementById('loose');
const looseList = looseSection.querySelector('.session-list');
const noProjects = document.getElementById('no-projects');
const empty = document.getElementById('empty');
const configError = document.getElementById('config-error');
const tabsEl = document.getElementById('tabs');
const rightPanel = document.getElementById('right-panel');

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

// 作った順に持つ
const sessions = new Map();
// タブで開いているファイル。パスごとに1つ
const fileViews = new Map();
// サブエージェントの記録と、端末ごとの一覧。開閉状態はこの窓の間だけ持つ
const subagentViews = new Map();
const subagentLists = new Map();
// コミットの詳細は、この窓の間だけ持つ
const commitViews = new Map();
let subagents = {};
let subagentsRefresh = null;
// projects.json のリポジトリと、その worktree。git から読み直す（refreshProjects）
let projects = [];
let workspaces = [{ id: 'default', name: '既定' }];
let activeWorkspace = 'default';
const workspaceStates = new Map();
const restoredKeys = new Map();
let projectRevision = 0;
let projectRefreshSerial = 0;
// タブは開いた順に並べる。キーは端末が 't:<番号>'、ファイルが 'f:<パス>'、サブの記録が 's:<パス>'、コミットが 'c:<worktree>@<ハッシュ>'。
// Orca と同じく、上のタブには表示中のタブと同じ作業（worktree）のものだけを出す
let tabOrder = [];
let activeKey = null;
let layout = createPane();
let activePaneId = layout.id;
const paneHost = document.getElementById('panes');
const viewStore = document.getElementById('view-store');
const panes = createPaneView(paneHost, {
  onActivate: activatePane,
  onClose: closeWorkspacePane,
  onRename: (id, name) => {
    const key = paneList(layout).find((p) => p.id === id)?.key;
    if (key?.startsWith('t:') && name) startRename(sessions.get(Number(key.slice(2))), name);
  },
  onDrop: dropTabInPane,
  canDropPaths: (id) => Boolean(dropTargetOf(id)),
  onDropPaths: (dataTransfer, id, event) => dropPaths(id, pathsFromTransfer(dataTransfer, terp.pathForFile), event),
  onResize: (next) => { layout = next; syncPanes(); saveTabs(); },
});
// 途中の状態で控えを上書きすると、まだ開き直していないファイルが消える
let restoringTabs = true;
let saveTabsTimer = null;
// 最後に表示したターミナル。ファイルのタブを表示している間も、新しいターミナルなどの基準に使う
let activeId = null;
// 最近表示したタブのキーの順。⌃Tab で直前へ戻るのに使う
let recent = [];
// どの作業にも入らないタブのまとまり
const LOOSE = '(loose)';
let config = await terp.getConfig();
let focusForTest = null;

// 背景は奥の面（body の --surface-term）1枚で塗る。端末側でも塗ると、透過のときに2枚重なって濃くなる
function terminalTheme(c) {
  return { ...c.terminal, background: 'rgba(0, 0, 0, 0)' };
}

function bufferText(id, { visible = false } = {}) {
  const s = sessions.get(id);
  if (!s) return '';
  const buf = s.term.buffer.active;
  const start = visible ? buf.viewportY : 0;
  const end = visible ? Math.min(buf.length, start + s.term.rows) : buf.length;
  const lines = [];
  for (let i = start; i < end; i++) lines.push(buf.getLine(i).translateToString(true));
  return lines.join('\n').replace(/\n+$/, '');
}

// 設定（色・フォント・透過）を、開いている端末・エディタ・枠に反映する
function applyConfig(c) {
  config = c;
  applySettingsConfig(c);
  applyEditorConfig(c);
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(c.chrome)) root.setProperty(`--color-${key}`, value);
  root.setProperty('--surface-term', withAlpha(c.chrome['term-bg'], c.window.opacity));
  root.setProperty('--surface-sidebar', withAlpha(c.chrome.bg, c.window.opacity));
  root.setProperty('--surface-favorite', withAlpha(c.chrome.accent, c.window.opacity));
  root.setProperty('--favorite-text', favoriteText(c.chrome.accent, c.chrome.text));
  root.setProperty('--window-blur', `${c.window.blur}px`);
  showWallpaper();
  root.setProperty('--font-mono', c.font.family);
  root.setProperty('--term-padding-x', `${c.paddingX}px`);
  root.setProperty('--term-padding-y', `${c.paddingY}px`);
  for (const [key, value] of Object.entries(c.terminal)) root.setProperty(`--history-${key}`, value);
  configError.textContent = c.error || '';
  configError.hidden = !c.error;
  // skipApprovals を切り替えたら、エージェントのボタンの説明と印も変える
  if (agentList.length) renderAgentButtons();
  refreshAgents();
  updateDockBadge();
  for (const s of sessions.values()) {
    s.term.options.theme = terminalTheme(c);
    s.term.options.fontFamily = c.font.family;
    s.term.options.fontSize = c.font.size;
    s.term.options.minimumContrastRatio = c.minimumContrast;
    s.term.options.cursorStyle = c.cursorStyle;
    s.term.options.cursorBlink = c.cursorBlink;
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

// 作業（worktree）の下での場所。作業の一番上なら空
function placeInWork(s, w) {
  return s.cwd === w.path ? '' : s.cwd.slice(w.path.length + 1);
}

// 名前の優先順: 自分で付けた名前 > claude などが作った題名 > 作業の下ならプログラム名 > 作業場所のフォルダ名
function displayName(s) {
  if (s.customName) return s.customName;
  if (isAgent(s) && s.agentTitle) return s.agentTitle;
  const w = workOf(s);
  // 作業の行に名前が出ているため、ターミナルの行で同じ名前を繰り返さない
  if (w) return isAgent(s) ? s.program : 'シェル';
  if (!s.cwd || s.cwd === terp.home) return '~';
  return s.cwd.split('/').pop();
}

// 2行目: 作業の下なら作業からの場所、それ以外は ~ からの場所
function placeLabel(s) {
  const w = workOf(s);
  if (w) return placeInWork(s, w);
  return shortPath(s.cwd) === displayName(s) ? '' : shortPath(s.cwd);
}

// 時計と DOM を参照しない、エージェントの状態と遷移。
function permissionMessage(message) {
  return /permission|approv|allow|許可|承認/i.test(message);
}

function agentState(s, now) {
  if (s.agentWaiting) return 'waiting';
  if (s.agentWorking || outputWorking(s, now)) return 'working';
  return s.agentDone ? 'done' : 'idle';
}

// 題名で作業中を知らせないもの（codex など）だけ、出力で考え中とみなす。
// 終わった後の1回の描き直しで考え中に戻らないよう、1秒以上続いている出力に限る
function outputWorking(s, now) {
  if (s.titleAware || !(s.lastAgentOutput > 0) || now - s.lastAgentOutput >= BUSY_MS) return false;
  return s.lastAgentOutput - (s.outputSince ?? s.lastAgentOutput) >= 1000;
}

function agentOutputCounts(lastInputAt, now) {
  return lastInputAt == null || now - lastInputAt > 500;
}

function reduceAgentStatus(s, event, now) {
  const next = {
    agentWorking: Boolean(s.agentWorking), agentWaiting: Boolean(s.agentWaiting),
    agentDone: Boolean(s.agentDone), lastAgentOutput: s.lastAgentOutput || 0,
    lastInputAt: s.lastInputAt ?? null, workingSince: s.workingSince ?? null, doneAt: s.doneAt ?? null,
    titleAware: Boolean(s.titleAware), outputSince: s.outputSince ?? null,
  };
  const before = agentState(next, now);
  if (event.type === 'input') {
    next.lastInputAt = now;
    next.agentWaiting = false;
  } else if (event.type === 'output' && !event.replaying && agentOutputCounts(next.lastInputAt, now)) {
    if (!(next.lastAgentOutput > 0) || now - next.lastAgentOutput >= BUSY_MS) next.outputSince = now;
    next.lastAgentOutput = now;
    next.agentWaiting = false;
  } else if (event.type === 'title') {
    next.agentWorking = event.working;
    // 一度でも題名で作業中を知らせたものは、以後は題名だけで考え中を決める
    if (event.working) { next.agentWaiting = false; next.titleAware = true; }
    else if (s.agentWorking) next.lastAgentOutput = 0;
  } else if (event.type === 'notification' && !event.replaying) {
    if (permissionMessage(event.message)) {
      next.agentWaiting = true;
      next.agentDone = false;
      next.agentWorking = false;
      next.lastAgentOutput = 0;
    } else if (!next.agentWaiting) {
      next.agentWorking = false;
      next.lastAgentOutput = 0;
      next.agentDone = !event.seen;
      next.doneAt = now;
    }
  } else if (event.type === 'seen') {
    next.agentDone = false;
  } else if (event.type === 'reset') {
    return { agentWorking: false, agentWaiting: false, agentDone: false, lastAgentOutput: 0,
      lastInputAt: null, workingSince: null, doneAt: null, titleAware: false, outputSince: null };
  }
  const after = agentState(next, now);
  if (after === 'working') {
    if (before !== 'working' || next.workingSince == null) next.workingSince = now;
    next.agentDone = false;
  } else next.workingSince = null;
  return next;
}

function agentStatusText(state, s, now) {
  const seconds = Math.max(0, Math.floor((now - (state === 'working' ? s.workingSince : s.doneAt)) / 1000));
  if (state === 'working') return '考え中 ' + (seconds >= 3600
    ? `${Math.floor(seconds / 3600)}時間${Math.floor(seconds / 60) % 60}分`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  if (state === 'waiting') return '許可待ち';
  if (state === 'done') return '終わった · ' + (seconds < 60 ? 'たった今' : seconds < 3600
    ? `${Math.floor(seconds / 60)}分前` : `${Math.floor(seconds / 3600)}時間前`);
  return '';
}

function stateOf(s, now = Date.now()) {
  if (isAgent(s)) return agentState(s, now);
  if (s.notify) return 'notify';
  if (now - s.lastOutput < BUSY_MS && s.lastOutput > s.createdAt + 1500) return 'busy';
  if (s.unread) return 'unread';
  return 'idle';
}

const STATE_LABELS = { busy: '出力中', unread: '未読の出力あり', notify: '通知あり', idle: '待機中',
  working: '考え中', waiting: '許可待ち', done: '終わった' };

function updateAgentStatus(s, event, now = Date.now()) {
  Object.assign(s, reduceAgentStatus(s, event, now));
}

// 従来の data-state は自己診断なども読むため、4状態は別の属性へ出す。
function renderStatus(el, s, state) {
  el.dataset.state = ({ working: 'busy', waiting: 'notify', done: 'notify' })[state] || state;
  if (isAgent(s)) el.dataset.agentState = state;
  else delete el.dataset.agentState;
  const dot = el.querySelector('.session__dot');
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', STATE_LABELS[state]);
  dot.textContent = state === 'waiting' ? '!' : '';
  // 文字は出さず、経過は印に指を置いたときだけ見せる
  const text = isAgent(s) ? agentStatusText(state, s, Date.now()) : '';
  if (text) dot.title = text;
  else dot.removeAttribute('title');
}

const termKey = (id) => `t:${id}`;
const fileKey = (path) => `f:${path}`;
const subagentKey = (path) => `s:${path}`;

function groupOf(key) {
  if (key.startsWith('c:')) return workOfPath(commitViews.get(key)?.top)?.path || LOOSE;
  if (key.startsWith('t:')) {
    const s = sessions.get(Number(key.slice(2)));
    return (s && workOf(s)?.path) || LOOSE;
  }
  if (key.startsWith('s:')) {
    const view = subagentViews.get(key.slice(2));
    return workOfPath(sessions.get(view?.sessionId)?.cwd || view?.cwd)?.path || LOOSE;
  }
  return workOfPath(key.slice(2))?.path || LOOSE;
}

// ⌘1〜⌘9 と前後の移動は、上のタブに見えている順に従う
function visibleKeys() {
  if (!activeKey) return [];
  const group = groupOf(activeKey);
  return tabOrder.filter((k) => workspaceOfKey(k) === activeWorkspace && groupOf(k) === group);
}

// 新しいターミナルやエージェントを開く場所: ファイルのタブならそのフォルダ、ターミナルならその作業場所
function activeCwd() {
  if (activeKey?.startsWith('c:')) return commitViews.get(activeKey)?.top || null;
  if (activeKey?.startsWith('f:')) return activeKey.slice(2).replace(/\/[^/]*$/, '');
  if (activeKey?.startsWith('s:')) {
    const view = subagentViews.get(activeKey.slice(2));
    return sessions.get(view?.sessionId)?.cwd || view?.cwd || null;
  }
  return sessions.get(activeId)?.workspace === activeWorkspace ? sessions.get(activeId).cwd : null;
}

function renderItem(s, index = visibleKeys().indexOf(termKey(s.id))) {
  const li = s.li;
  const state = stateOf(s);
  renderStatus(li, s, state);
  li.dataset.favorite = String(Boolean(s.favorite));
  const star = li.querySelector('[data-action="favorite"]');
  star.setAttribute('aria-pressed', String(Boolean(s.favorite)));
  star.setAttribute('aria-label', favoriteLabel(s.favorite));
  star.title = favoriteLabel(s.favorite);
  li.setAttribute('aria-current', String(activeKey === termKey(s.id)));
  li.title = [s.title, shortPath(s.cwd)].filter(Boolean).join('\n');
  const nameEl = li.querySelector('.session__name');
  if (nameEl) nameEl.textContent = displayName(s);
  const name = displayName(s);
  // 名前がプログラム名なら2行目で繰り返さない
  const program = isAgent(s) && name !== s.program ? s.program : '';
  li.querySelector('.session__sub').textContent = [program, placeLabel(s)].filter(Boolean).join(' · ');
  // 番号は上のタブに出ているものだけに付ける（⌘1〜⌘9 はタブの順）
  li.querySelector('.session__key').textContent = index >= 0 && index < 9 ? `⌘${index + 1}` : '';
  li.querySelector('.session__bypass').hidden = !s.bypass;
}

function renderAll() {
  placeSessions();
  const now = Date.now();
  const focused = focusForTest ?? document.hasFocus();
  for (const s of sessions.values()) {
    updateAgentStatus(s, { type: 'tick' }, now);
    if (focused && terminalVisible(s)) updateAgentStatus(s, { type: 'seen' }, now);
  }
  const visible = visibleKeys();
  for (const s of sessions.values()) renderItem(s, visible.indexOf(termKey(s.id)));
  for (const list of subagentLists.values()) {
    for (const row of list.el.querySelectorAll('.subagent')) {
      row.setAttribute('aria-current', String(Boolean(row.dataset.file) && activeKey === subagentKey(row.dataset.file)));
      row.querySelector('.subagent__time').textContent = elapsedLabel(row.dataset.since);
    }
  }
  const group = activeKey ? groupOf(activeKey) : null;
  for (const el of projectsEl.querySelectorAll('.work')) {
    el.querySelector('.work__row').setAttribute('aria-current', String(group === el.dataset.path));
  }
  renderWorkStatuses();
  renderWorkspaceStatuses();
  updateDockBadge();
  renderTabs(visible);
  renderPaneTitles();
  empty.hidden = Boolean(activeKey);
}

// ---- 上のタブ ----

const TAB_FILE_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>`;

function tabLabel(key) {
  if (key.startsWith('c:')) {
    const view = commitViews.get(key);
    return `${view.hash.slice(0, 7)} ${view.subject || ''}`.trim();
  }
  if (key.startsWith('t:')) return displayName(sessions.get(Number(key.slice(2))));
  if (key.startsWith('s:')) return subagentViews.get(key.slice(2))?.agent.description || 'サブエージェント';
  return key.split('/').pop();
}

function renderTabs(visible) {
  // 状態の印は 0.5 秒ごとに変わるため、タブの並びが同じなら中身だけ書き換える
  const same = tabsEl.children.length === visible.length && [...tabsEl.children].every((t, i) => t.dataset.key === visible[i]);
  if (!same) {
    tabsEl.textContent = '';
    for (const key of visible) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.key = key;
      makeTabDraggable(tab, key);
      tab.setAttribute('role', 'tab');
      tab.innerHTML = `${key.startsWith('t:') ? '<span class="session__dot tab__dot"></span>' : key.startsWith('s:') ? AGENT_ICON : TAB_FILE_ICON}<span class="tab__name"></span>
        <button class="tab__close" type="button" aria-label="閉じる" title="閉じる（⌘W）">${CLOSE_ICON}</button>`;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.tab__close')) closeKey(key);
        else activateKey(key);
      });
      // 中ボタンで閉じる（ブラウザと同じ）
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeKey(key));
      tabsEl.append(tab);
    }
  }
  for (const tab of tabsEl.children) {
    const key = tab.dataset.key;
    tab.setAttribute('aria-selected', String(key === activeKey));
    const dirty = key.startsWith('f:') && fileViews.get(key.slice(2))?.view?.dirty;
    tab.querySelector('.tab__name').textContent = tabLabel(key) + (dirty ? ' ●' : '');
    tab.dataset.dirty = String(Boolean(dirty));
    tab.title = key.startsWith('t:') ? sessions.get(Number(key.slice(2)))?.cwd || '' : key.startsWith('s:') ? `サブエージェント: ${tabLabel(key)}` : key.slice(2);
    if (key.startsWith('t:')) {
      const s = sessions.get(Number(key.slice(2)));
      renderStatus(tab, s, stateOf(s));
    }
  }
  tabsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderPaneTitles() {
  for (const pane of paneList(layout)) {
    const header = panes.element(pane.id)?.querySelector('.pane__title');
    if (!header) continue;
    const key = pane.key;
    const view = viewOf(key);
    const terminal = Boolean(view && key.startsWith('t:'));
    const file = Boolean(view && key.startsWith('f:'));
    const text = paneTitle({
      kind: terminal ? 'terminal' : file ? 'file' : 'record',
      name: view ? tabLabel(key) : '',
      program: terminal ? view.program : '',
      cwd: terminal ? view.cwd : '', home: terp.home,
      work: terminal ? workOf(view) : file ? workOfPath(key.slice(2), workspaceOfKey(key)) : null,
      path: file ? key.slice(2) : '', dirty: file && view.view?.dirty,
    });
    header.title = text.title;
    const name = header.querySelector('.pane__name');
    if (name) name.textContent = text.name;
    header.querySelector('.pane__detail').textContent = text.detail;
    header.querySelector('.session__dot').hidden = !terminal;
    if (terminal) renderStatus(header, view, stateOf(view));
    else {
      delete header.dataset.state;
      delete header.dataset.agentState;
    }
  }
}

// ---- 作業（worktree） ----

function currentProjects() {
  return projects.filter((p) => p.workspace === activeWorkspace);
}

function allWorks(workspace = activeWorkspace) {
  return projects.filter((p) => !workspace || p.workspace === workspace).flatMap((p) => p.worktrees.map((w) => ({ ...w, repo: p.path })));
}

// その場所を含む worktree のうち、いちばん深いもの
function workOfPath(p, workspace = activeWorkspace) {
  let found = null;
  for (const w of allWorks(workspace)) {
    if ((p === w.path || p?.startsWith(w.path + '/')) && (!found || w.path.length > found.path.length)) found = w;
  }
  return found;
}

function workOf(s) {
  return workOfPath(s.cwd, s.workspace || activeWorkspace);
}

function workLabel(w) {
  return w.branch || `（ブランチなし）${w.head}`;
}

const BRANCH_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-6 8" /></svg>`;
const PLUS_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>`;
const CLOSE_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>`;
const TRASH_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- ワークスペース ----

function workspaceOfKey(key) {
  if (!key) return null;
  if (key.startsWith('s:')) {
    const view = viewOf(key);
    return sessions.get(view?.sessionId)?.workspace || view?.workspace || activeWorkspace;
  }
  return viewOf(key)?.workspace || null;
}

function workspaceKeys(id = activeWorkspace) {
  return tabOrder.filter((key) => workspaceOfKey(key) === id);
}

function rememberWorkspace() {
  workspaceStates.set(activeWorkspace, { active: activeKey, layout: structuredClone(layout), activePaneId, activeId });
}

function showWorkspaceState(id) {
  const saved = workspaceStates.get(id);
  const keys = workspaceKeys(id);
  const fallback = keys.includes(activeKey) ? activeKey : keys.find((key) => key.startsWith('t:')) || null;
  const wanted = keys.includes(saved?.active) ? saved.active : fallback;
  layout = saved?.layout ? restoreLayout(saved.layout, keys, { transient: true }) : createPane(wanted);
  const selected = paneList(layout).find((p) => p.id === saved?.activePaneId && p.key === saved?.active)
    || paneList(layout).find((p) => p.key === wanted) || paneList(layout)[0];
  activePaneId = selected.id;
  activeKey = selected.key;
  activeId = sessions.get(saved?.activeId)?.workspace === id ? saved.activeId : null;
  if (!activeKey && wanted) {
    layout = replacePane(layout, activePaneId, wanted);
    activeKey = wanted;
  }
  syncPanes();
  renderProjects();
  if (activeKey) activateKey(activeKey);
  else {
    refreshGit(true);
    refreshHistory();
    refreshFiles(false);
    saveTabs();
  }
}

async function switchWorkspace(id, persist = true) {
  if (id === activeWorkspace || !workspaces.some((w) => w.id === id)) return;
  projectRevision++;
  rememberWorkspace();
  activeWorkspace = id;
  rowMenu.close();
  workspaceUI.menu.close();
  showWorkspaceState(id);
  if (persist) {
    const res = await terp.activateWorkspace(id);
    if (!res.ok) { workspaceUI.error(res.error); await refreshProjects(); }
  }
}

function repairWorkspaceLayout() {
  const keys = workspaceKeys();
  if (paneList(layout).every((p) => !p.key || keys.includes(p.key))) return;
  rememberWorkspace();
  showWorkspaceState(activeWorkspace);
}

function workspaceDeleteReason(id) {
  if (workspaces.length === 1) return '最後のワークスペースは削除できない';
  if (projects.some((p) => p.workspace === id) || [...sessions.values()].some((s) => s.workspace === id)) return 'リポジトリかターミナルがあるため削除できない';
  return '';
}

async function createWorkspace(name) {
  const res = await terp.createWorkspace(name);
  if (!res.ok) throw new Error(res.error);
  await refreshProjects();
  await switchWorkspace(res.value.id);
  return res.value;
}

async function removeWorkspace(id) {
  const reason = workspaceDeleteReason(id);
  if (reason) { workspaceUI.error(reason); return false; }
  const res = await terp.removeWorkspace(id);
  if (!res.ok) { workspaceUI.error(res.error); return false; }
  await refreshProjects();
  workspaceStates.delete(id);
  const remainingFiles = [...fileViews.values()].filter((view) => view.workspace === id);
  for (const view of remainingFiles) view.workspace = activeWorkspace;
  if (remainingFiles.length) activateKey(fileKey(remainingFiles[0].path));
  saveTabs();
  return true;
}

function statusElement(id) {
  const span = document.createElement('span');
  span.className = 'work__status';
  span.dataset.workspaceStatus = id;
  span.innerHTML = '<span class="session__dot"></span><span class="work__status-count"></span>';
  renderWorkspaceStatus(span, id);
  return span;
}

function renderWorkspaceStatus(el, id) {
  const summary = urgentAgentSessions([...sessions.values()].filter((s) => s.workspace === id));
  el.hidden = !summary.sessions.length;
  if (el.hidden) return;
  renderStatus(el, summary.sessions[0], summary.state);
  el.querySelector('.work__status-count').textContent = summary.sessions.length > 1 ? summary.sessions.length : '';
  el.setAttribute('aria-label', `${STATE_LABELS[summary.state]} ${summary.sessions.length}件`);
}

function renderWorkspaceStatuses() {
  workspaceUI.button.querySelector('.menu__label').textContent = workspaces.find((w) => w.id === activeWorkspace)?.name || '';
  workspaceUI.button.setAttribute('aria-label', `ワークスペース: ${workspaces.find((w) => w.id === activeWorkspace)?.name || ''}`);
  // 表示していないワークスペースからの知らせも、閉じた切り替え部品に残す。
  const summary = urgentAgentSessions([...sessions.values()]);
  const badge = workspaceUI.button.querySelector('.work__status');
  badge.hidden = !summary.sessions.length;
  if (!badge.hidden) {
    renderStatus(badge, summary.sessions[0], summary.state);
    badge.querySelector('.work__status-count').textContent = summary.sessions.length > 1 ? summary.sessions.length : '';
    badge.setAttribute('aria-label', `${STATE_LABELS[summary.state]} ${summary.sessions.length}件`);
  }
  for (const el of workspaceUI.menu.el.querySelectorAll('[data-workspace-status]')) renderWorkspaceStatus(el, el.dataset.workspaceStatus);
}

const rowMenu = createMenu();
const workspaceUI = createWorkspaceUI({
  menuItems: () => [
    ...workspaces.map((w) => ({ id: w.id, label: w.name, checked: w.id === activeWorkspace, status: statusElement(w.id), run: () => switchWorkspace(w.id) })),
    { separator: true },
    { label: '新しいワークスペース…', run: () => workspaceUI.edit() },
    { label: '名前を変更…', run: () => workspaceUI.edit(workspaces.find((w) => w.id === activeWorkspace)) },
    { label: 'ワークスペースを削除', reason: workspaceDeleteReason(activeWorkspace), run: () => removeWorkspace(activeWorkspace) },
  ],
  submitName: async (id, name) => {
    if (!id) await createWorkspace(name);
    else {
      const res = await terp.renameWorkspace(id, name);
      if (!res.ok) throw new Error(res.error);
      await refreshProjects();
    }
  },
});

const overview = createOverview({
  host: workspaceUI.button.parentElement,
  snapshot: () => {
    const ordered = [...workspaces.filter((w) => w.id === activeWorkspace), ...workspaces.filter((w) => w.id !== activeWorkspace)];
    const list = allSessionsInListOrder();
    return {
      workspaces: ordered,
      activeId,
      items: ordered.flatMap((w) => list.filter((s) => s.workspace === w.id)).map((s) => {
        const work = workOf(s);
        const repo = projects.find((p) => p.path === work?.repo && p.workspace === s.workspace);
        return { id: s.id, workspace: s.workspace, name: displayName(s), favorite: s.favorite,
          repoPath: repo?.path || null, repoName: repo?.name || '', branch: work?.branch || '',
          cwd: s.cwd, workPath: work?.path || '', current: s.workspace === activeWorkspace && terminalVisible(s) };
      }),
    };
  },
  preview: (id) => bufferText(id, { visible: true }).split('\n').slice(-8).join('\n'),
  renderStatus: (tile, item) => {
    const s = sessions.get(item.id);
    renderStatus(tile, s, stateOf(s));
  },
  star: STAR_ICON,
  activate,
  restoreFocus: () => {
    const view = viewOf(activeKey);
    if (view?.term) view.term.focus();
    else if (view?.view?.editor) view.view.editor.focus();
    else view?.el.querySelector('.fileview__body, .subagent-view__body, .commit-view__body')?.focus({ preventScroll: true });
  },
  beforeOpen: () => { rowMenu.close(); workspaceUI.menu.close(); closeTabMenu(); },
});

function moveWorkspaceMenu(current, run) {
  return { label: 'ワークスペースへ移す', children: workspaces.map((w) => ({
    label: w.name, checked: w.id === current, run: () => run(w.id),
  })) };
}

async function moveProjectWorkspace(repo, id) {
  projectRevision++;
  const project = projects.find((p) => p.path === repo);
  const res = await terp.updateProject(repo, { workspace: id });
  if (!res.ok) { workspaceUI.error(res.error); return; }
  if (project) {
    for (const [path, view] of fileViews) {
      if (project.worktrees.some((w) => path === w.path || path.startsWith(w.path + '/'))) view.workspace = id;
    }
  }
  await refreshProjects();
  repairWorkspaceLayout();
  saveTabs();
}

function moveSessionWorkspace(id, workspace) {
  const s = sessions.get(id);
  if (!s || !workspaces.some((w) => w.id === workspace)) return;
  s.workspace = workspace;
  for (const view of subagentViews.values()) if (view.sessionId === id) view.workspace = workspace;
  terp.setMeta(id, { workspace });
  repairWorkspaceLayout();
  renderAll();
  saveTabs();
}

async function toggleProjectFavorite(repo) {
  projectRevision++;
  const project = projects.find((p) => p.path === repo);
  if (!project) return;
  const res = await terp.updateProject(repo, { favorite: !project.favorite });
  if (!res.ok) workspaceUI.error(res.error);
  else await refreshProjects();
}

function toggleSessionFavorite(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.favorite = !s.favorite;
  terp.setMeta(id, { favorite: s.favorite });
  renderItem(s);
}

function allSessionsInListOrder() {
  const result = [];
  for (const workspace of workspaces) {
    const list = [...sessions.values()].filter((s) => s.workspace === workspace.id);
    for (const project of projects.filter((p) => p.workspace === workspace.id)) {
      for (const work of project.worktrees) result.push(...list.filter((s) => workOf(s)?.path === work.path));
    }
    result.push(...list.filter((s) => !workOf(s)));
  }
  return result;
}

// リポジトリと作業の行を描き直す。ターミナルの行（li）は作り直さず、placeSessions で入れ替える
function renderProjects() {
  // 描き直す前に、ターミナルの行を退避しておく
  for (const s of sessions.values()) looseList.appendChild(s.li);
  projectsEl.innerHTML = '';
  for (const p of currentProjects()) {
    const section = document.createElement('section');
    section.className = 'project';
    section.dataset.path = p.path;
    section.innerHTML = `
      <div class="project__head" data-favorite="${Boolean(p.favorite)}" title="${escapeHtml(shortPath(p.path))}&#10;ドラッグか ⌥↑ / ⌥↓ で並べ替え" draggable="true" tabindex="0">
        <span class="project__name">${escapeHtml(p.name)}</span>
        <button class="icon-btn icon-btn--hover favorite" type="button" data-action="favorite" aria-pressed="${Boolean(p.favorite)}" aria-label="${favoriteLabel(p.favorite)}" title="${favoriteLabel(p.favorite)}">${STAR_ICON}</button>
        <button class="icon-btn" type="button" data-action="new-work" aria-label="${escapeHtml(p.name)} に新しい作業を作る" title="新しい作業">${PLUS_ICON}</button>
        <button class="icon-btn icon-btn--hover" type="button" data-action="forget" aria-label="${escapeHtml(p.name)} を一覧から外す" title="一覧から外す（ファイルは消さない）">${CLOSE_ICON}</button>
      </div>`;
    section.querySelector('[data-action="new-work"]').addEventListener('click', () => openWorkDialog(p.path));
    setupProjectDrag(section, p.path);
    section.querySelector('[data-action="favorite"]').addEventListener('click', () => toggleProjectFavorite(p.path));
    section.querySelector('.project__head').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      rowMenu.open([
        { label: favoriteLabel(p.favorite), run: () => toggleProjectFavorite(p.path) },
        moveWorkspaceMenu(p.workspace, (id) => moveProjectWorkspace(p.path, id)),
      ], { x: e.clientX, y: e.clientY, target: e.currentTarget });
    });
    section.querySelector('[data-action="forget"]').addEventListener('click', async () => {
      await terp.removeProject(p.path);
      refreshProjects();
    });
    if (p.error) {
      const err = document.createElement('p');
      err.className = 'project__error';
      err.textContent = p.error;
      section.appendChild(err);
    }
    for (const w of p.worktrees) {
      const work = document.createElement('div');
      work.className = 'work';
      work.dataset.path = w.path;
      const changes = w.changes ? `<span class="badge" title="変更のあるファイル">${w.changes}</span>` : '';
      const main = w.main ? '<span class="work__tag">本体</span>' : '';
      const remove = w.main
        ? ''
        : `<button class="icon-btn icon-btn--hover" type="button" data-action="remove" aria-label="作業 ${escapeHtml(workLabel(w))} を削除" title="作業を削除">${TRASH_ICON}</button>`;
      work.innerHTML = `
        <div class="work__row" role="button" tabindex="0" title="${escapeHtml(shortPath(w.path))}">
          ${BRANCH_ICON}
          <span class="work__name">${escapeHtml(workLabel(w))}</span>
          ${main}${changes}${remove}
          <button class="work__status" type="button" hidden><span class="session__dot"></span><span class="work__status-count"></span></button>
        </div>
        <ul class="session-list"></ul>`;
      const row = work.querySelector('.work__row');
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openWork({ ...w, repo: p.path });
      });
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') openWork({ ...w, repo: p.path });
      });
      work.querySelector('.work__status').addEventListener('click', () => {
        const summary = urgentAgentSessions(sessionsInListOrder().filter((s) => workOf(s)?.path === w.path));
        if (summary.sessions.length) activate(summary.sessions[0].id);
      });
      work.querySelector('[data-action="remove"]')?.addEventListener('click', () => openRemoveDialog({ ...w, repo: p.path }));
      section.appendChild(work);
    }
    projectsEl.appendChild(section);
  }
  noProjects.hidden = currentProjects().length > 0;
  renderAll();
}

// 各ターミナルの行を、作業場所を含む作業の下へ動かす。どれにも入らないものは「その他」へ
function placeSessions() {
  for (const s of sessions.values()) {
    if (s.workspace !== activeWorkspace) {
      s.li.remove();
      subagentLists.get(s.id)?.el.remove();
      continue;
    }
    const w = workOf(s);
    const target = (w && projectsEl.querySelector(`.work[data-path="${CSS.escape(w.path)}"] .session-list`)) || looseList;
    // 名前の編集中に動かすと入力欄の選択が外れるため、動かす必要があるときだけ動かす
    if (s.li.parentElement !== target) {
      const after = [...target.children].find((li) => li.classList.contains('session') && Number(li.dataset.id) > s.id);
      target.insertBefore(s.li, after || null);
    }
    const children = subagentLists.get(s.id)?.el;
    if (children && s.li.nextElementSibling !== children) s.li.after(children);
  }
  looseSection.hidden = looseList.children.length === 0;
}

function terminalVisible(s) {
  return paneList(layout).some((p) => p.key === termKey(s.id));
}

function sessionsInListOrder() {
  return [...document.querySelectorAll('#projects .session, #loose .session')]
    .map((el) => sessions.get(Number(el.dataset.id))).filter(Boolean);
}

function urgentAgentSessions(list, now = Date.now()) {
  for (const state of ['waiting', 'done', 'working']) {
    const matches = list.filter((s) => isAgent(s) && stateOf(s, now) === state);
    if (matches.length) return { state, sessions: matches };
  }
  return { state: 'idle', sessions: [] };
}

function renderWorkStatuses() {
  const list = sessionsInListOrder();
  for (const work of projectsEl.querySelectorAll('.work')) {
    const summary = urgentAgentSessions(list.filter((s) => workOf(s)?.path === work.dataset.path));
    const button = work.querySelector('.work__status');
    button.hidden = summary.sessions.length === 0;
    if (button.hidden) continue;
    renderStatus(button, summary.sessions[0], summary.state);
    button.querySelector('.work__status-count').textContent = summary.sessions.length > 1 ? summary.sessions.length : '';
    button.setAttribute('aria-label', `${STATE_LABELS[summary.state]} ${summary.sessions.length}件の先頭を表示`);
  }
}

let lastDockCount = null;
function updateDockBadge() {
  const count = config.dockBadge === false ? 0 : [...sessions.values()]
    .filter((s) => isAgent(s) && ['waiting', 'done'].includes(stateOf(s))).length;
  if (count === lastDockCount) return;
  lastDockCount = count;
  terp.setDockBadge(count);
}

function nextAttention() {
  const list = allSessionsInListOrder();
  const summary = urgentAgentSessions(list);
  if (!['waiting', 'done'].includes(summary.state)) return;
  const at = list.findIndex((s) => termKey(s.id) === activeKey);
  const next = summary.sessions.find((s) => list.indexOf(s) > at) || summary.sessions[0];
  activate(next.id);
}

// ---- リポジトリの並べ替え（ドラッグ＆ドロップと ⌥↑ / ⌥↓） ----

let draggingProject = null;
// 並びの記録を書いている間。読み直すと古い順に戻って見えるため待つ
let reordering = false;

async function moveProject(from, toIndex) {
  projectRevision++;
  const order = currentProjects().map((p) => p.path).filter((p) => p !== from);
  order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, from);
  // 画面を先に並べ替え、記録は後から合わせる（戻ってくるのを待つとちらつくため）
  const sorted = order.map((path) => projects.find((p) => p.path === path));
  projects = projects.map((p) => p.workspace === activeWorkspace ? sorted.shift() : p);
  renderProjects();
  reordering = true;
  try {
    await terp.reorderProjects(order);
  } finally {
    reordering = false;
  }
}

function clearDropMarks() {
  for (const el of projectsEl.querySelectorAll('[data-drop]')) delete el.dataset.drop;
}

function setupProjectDrag(section, path) {
  const head = section.querySelector('.project__head');
  head.addEventListener('dragstart', (e) => {
    draggingProject = path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-terp-project', path);
    section.dataset.dragging = 'true';
  });
  head.addEventListener('dragend', () => {
    draggingProject = null;
    delete section.dataset.dragging;
    clearDropMarks();
  });
  // 落とす先の上半分なら前へ、下半分なら後ろへ入れる
  section.addEventListener('dragover', (e) => {
    if (!draggingProject || draggingProject === path) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = section.getBoundingClientRect();
    clearDropMarks();
    section.dataset.drop = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget)) delete section.dataset.drop;
  });
  section.addEventListener('drop', (e) => {
    if (!draggingProject || draggingProject === path) return;
    e.preventDefault();
    const from = draggingProject;
    const after = section.dataset.drop === 'after';
    draggingProject = null;
    clearDropMarks();
    const rest = currentProjects().map((p) => p.path).filter((p) => p !== from);
    moveProject(from, rest.indexOf(path) + (after ? 1 : 0));
  });
  head.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const index = currentProjects().findIndex((p) => p.path === path);
    moveProject(path, index + (e.key === 'ArrowUp' ? -1 : 1)).then(() =>
      projectsEl.querySelector(`.project[data-path="${CSS.escape(path)}"] .project__head`)?.focus(),
    );
  });
}

async function refreshProjects() {
  // つかんでいる間に描き直すと、つかんだ行が消えるため待つ
  if (draggingProject || reordering) return;
  const serial = ++projectRefreshSerial;
  const revision = projectRevision;
  const [res, state] = await Promise.all([terp.listProjects(), terp.listWorkspaces()]);
  if (!res.ok || !state.ok || draggingProject || reordering || serial !== projectRefreshSerial || revision !== projectRevision) return;
  const next = res.value;
  const changed = JSON.stringify(next) !== JSON.stringify(projects) || JSON.stringify(workspaces) !== JSON.stringify(state.value.workspaces);
  projects = next;
  workspaces = state.value.workspaces;
  if (state.value.activeWorkspace !== activeWorkspace) await switchWorkspace(state.value.activeWorkspace, false);
  else if (changed) renderProjects();
  repairWorkspaceLayout();
}

// ---- サブエージェントの一覧と記録 ----

function elapsedLabel(since) {
  if (!since) return '';
  const milliseconds = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(milliseconds)) return '';
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 1) return '1分未満';
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}時間`;
  return `${Math.floor(minutes / 1440)}日`;
}

function renderSubagents(id) {
  const agents = subagents[id] || [];
  let list = subagentLists.get(id);
  if (!list) {
    const el = document.createElement('li');
    el.className = 'subagents';
    el.dataset.session = id;
    list = { el, expanded: false };
    subagentLists.set(id, list);
  }
  list.el.textContent = '';
  const rows = document.createElement('ul');
  rows.className = 'session-list';
  list.el.append(rows);
  function appendAgent(agent) {
    const li = document.createElement('li');
    const clickable = agent.kind === 'claude' && Boolean(agent.file);
    const row = document.createElement(clickable ? 'button' : 'div');
    row.className = 'subagent';
    if (clickable) row.type = 'button';
    row.dataset.id = agent.id;
    if (clickable) row.dataset.file = agent.file;
    row.dataset.running = String(agent.running);
    row.dataset.since = agent.running ? agent.startedAt : agent.updatedAt;
    row.title = [agent.description, agent.lastAction, agent.running ? '動いている' : '終わった'].filter(Boolean).join('\n');
    row.innerHTML = '<span class="session__dot subagent__dot"></span><span class="subagent__name"></span><span class="subagent__time"></span><span class="subagent__action"></span>';
    row.querySelector('.subagent__dot').setAttribute('aria-label', agent.running ? '動いている' : '終わった');
    row.querySelector('.subagent__name').textContent = agent.description || agent.agentType || 'サブエージェント';
    row.querySelector('.subagent__action').textContent = agent.lastAction || '';
    row.querySelector('.subagent__time').textContent = elapsedLabel(row.dataset.since);
    if (clickable) {
      row.addEventListener('click', () => openSubagent(id, agent));
      makeTabDraggable(row, subagentKey(agent.file));
    }
    li.append(row);
    rows.append(li);
  }
  for (const agent of agents.filter((a) => a.running)) appendAgent(agent);
  const finished = agents.filter((a) => !a.running);
  if (finished.length) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'subagents__finished';
    button.setAttribute('aria-expanded', String(list.expanded));
    button.textContent = `${list.expanded ? '▾' : '▸'} 終わったもの ${finished.length} 件`;
    button.addEventListener('click', () => {
      list.expanded = !list.expanded;
      renderSubagents(id);
      renderAll();
    });
    li.append(button);
    rows.append(li);
    if (list.expanded) for (const agent of finished) appendAgent(agent);
  }
  list.el.hidden = agents.length === 0;
}

async function refreshSubagents() {
  if (subagentsRefresh) return subagentsRefresh;
  subagentsRefresh = refreshSubagentLists();
  try {
    await subagentsRefresh;
  } finally {
    subagentsRefresh = null;
  }
}

async function refreshSubagentLists() {
  try {
    const res = await terp.listSubagents();
    if (!res.ok) return;
    const next = res.value;
    if (JSON.stringify(next) === JSON.stringify(subagents)) return;
    const previous = subagents;
    subagents = next;
    for (const id of sessions.keys()) {
      if (JSON.stringify(previous[id] || []) !== JSON.stringify(next[id] || []) || !subagentLists.has(id)) renderSubagents(id);
    }
    for (const view of subagentViews.values()) {
      const agent = (next[view.sessionId] || []).find((a) => a.file === view.agent.file);
      const wasRunning = view.agent.running;
      view.agent = agent || { ...view.agent, running: false };
      updateSubagentHeading(view);
      // 終了の直前に書かれた行も読む
      if (wasRunning) readSubagentView(view);
    }
    renderAll();
  } catch {
    // 一時的に読めない間も、見ている記録と前回の一覧は残す
  }
}

function updateSubagentHeading(view) {
  view.el.querySelector('.subagent-view__title').textContent = view.agent.description || 'サブエージェント';
  view.el.querySelector('.subagent-view__meta').textContent = [view.agent.agentType, view.agent.running ? '動いている' : '終わった'].filter(Boolean).join(' · ');
}

async function readSubagentView(view) {
  if (subagentViews.get(view.agent.file) !== view) return;
  if (view.reading) {
    view.needsRead = true;
    return;
  }
  view.reading = true;
  const body = view.el.querySelector('.subagent-view__body');
  try {
    const res = await terp.readSubagent(view.agent.file, view.offset);
    if (subagentViews.get(view.agent.file) !== view) return;
    if (!res.ok) {
      view.readError = true;
      view.notice.textContent = '記録を読めない。しばらく待って読み直す';
      return;
    }
    view.readError = false;
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 24;
    if (view.offset !== undefined && res.value.offset < view.offset) body.textContent = '';
    view.offset = res.value.offset;
    const fragment = document.createDocumentFragment();
    for (const entry of res.value.entries) {
      const row = document.createElement('div');
      row.className = 'subagent-view__entry';
      row.dataset.type = entry.t;
      const time = document.createElement('time');
      const date = new Date(entry.at);
      time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
      const kind = document.createElement('span');
      kind.className = 'subagent-view__kind';
      kind.textContent = { text: '話す', tool: '道具', result: '結果' }[entry.t] || '';
      const text = document.createElement('div');
      text.className = 'subagent-view__text';
      text.textContent = entry.text;
      row.append(time, kind, text);
      fragment.append(row);
    }
    body.append(fragment);
    view.notice.textContent = body.children.length ? '' : '記録を待っている';
    if (follow) body.scrollTop = body.scrollHeight;
  } catch {
    view.readError = true;
    view.notice.textContent = '記録を読めない。しばらく待って読み直す';
  } finally {
    view.reading = false;
    if (view.needsRead) {
      view.needsRead = false;
      readSubagentView(view);
    }
  }
}

async function openSubagent(sessionId, agent, show = true) {
  const key = subagentKey(agent.file);
  if (subagentViews.has(agent.file)) {
    if (show) activateKey(key);
    return;
  }
  const el = document.createElement('section');
  el.className = 'subagent-view';
  el.hidden = true;
  el.innerHTML = '<header class="subagent-view__head"><h2 class="subagent-view__title"></h2><span class="subagent-view__meta"></span></header><p class="subagent-view__notice" role="status">記録を読み込み中</p><div class="subagent-view__body" tabindex="0" aria-label="サブエージェントの記録"></div>';
  const view = { agent, sessionId, workspace: sessions.get(sessionId)?.workspace || activeWorkspace, cwd: sessions.get(sessionId)?.cwd, el, notice: el.querySelector('.subagent-view__notice'), offset: undefined, reading: false };
  subagentViews.set(agent.file, view);
  viewStore.append(el);
  updateSubagentHeading(view);
  const at = tabOrder.indexOf(activeKey);
  tabOrder.splice(at < 0 ? tabOrder.length : at + 1, 0, key);
  if (show) activateKey(key);
  await readSubagentView(view);
}

// 作業を開く: その作業のタブのうち最近見たものへ移る。無ければ新しくターミナルを開く
function openWork(w) {
  const inWork = recent.find((key) => workspaceOfKey(key) === activeWorkspace && groupOf(key) === w.path);
  if (inWork !== undefined) activateKey(inWork);
  else openTerminal({ cwd: w.path });
}

async function addProject(dir) {
  const res = await terp.addProject(dir, activeWorkspace);
  if (res.ok && res.value) await refreshProjects();
  return res;
}

// ---- AI エージェントの起動 ----

const agentsEl = document.getElementById('agents');
let agentList = [];
let agentRegistry = [];
let agentRefreshSerial = 0;

// シェルに打つ1行。args は既存のシェルの書式を保つ。場所を上書きしたときだけ絶対パスで打ち、
// 実行ファイルは記号を含むときだけ、環境変数の値は必ず引用する
function agentCommandLine(a, bypass = false) {
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const env = Object.entries(a.env || {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  const prefix = env.length ? ['env', ...env.map(([key, value]) => `${key}=${quote(value)}`)] : [];
  const file = a.configuredPath || a.alias || a.command;
  const command = /^[\w@%+=:,./-]+$/.test(file) ? file : quote(file);
  return [...prefix, command, a.args, bypass ? a.bypassArgs : ''].filter(Boolean).join(' ');
}

// 確認を飛ばすか。普段は設定の skipApprovals に従い、⌥ を押しながらなら逆にする。飛ばす引数が無いものは飛ばさない
function wantsBypass(a, altKey = false) {
  return Boolean(a.bypassArgs) && config.skipApprovals !== altKey;
}

function agentTitle(a) {
  if (!a.bypassArgs) return `${a.label} を新しいターミナルで起動`;
  return config.skipApprovals
    ? `${a.label} を確認なしで起動（${a.bypassArgs}）。⌥ を押しながらで確認あり`
    : `${a.label} を起動。⌥ を押しながらで確認なし（${a.bypassArgs}）`;
}

async function refreshAgents() {
  const serial = ++agentRefreshSerial;
  const res = await terp.listAgents();
  if (serial !== agentRefreshSerial || !res.ok) return;
  agentRegistry = res.value;
  agentList = agentRegistry.filter((a) => a.found && !a.hidden);
  renderAgentButtons();
  if (!tabMenu.hidden) openTabMenu();
}

function renderAgentButtons() {
  agentsEl.textContent = '';
  for (const a of agentList) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--agent';
    btn.dataset.command = a.command;
    btn.innerHTML = `${agentIcon(a)}<span></span>`;
    // 左の一覧は幅が狭いため、表示名ではなく短いコマンドの名前を出す
    btn.querySelector('span').textContent = a.command.split('/').pop();
    btn.title = agentTitle(a);
    btn.dataset.bypass = String(wantsBypass(a));
    btn.setAttribute('aria-label', `${a.label} を起動`);
    btn.addEventListener('click', (e) => launchAgent(a, wantsBypass(a, e.altKey)));
    agentsEl.append(btn);
  }
  agentsEl.hidden = agentList.length === 0;
  renderMainAgentButton();
}

// ---- タブの並びの隣: 新しいタブのプルダウンと、メインのエージェントのボタン ----

const tabNewBtn = document.getElementById('tab-new');
const tabMenu = document.getElementById('tab-menu');
const mainAgentBtn = document.getElementById('tab-main-agent');

// 設定の mainAgent に当たるもの。書いていないか見つからなければ、見つかった最初のもの
function mainAgent() {
  const name = config.mainAgent;
  return agentList.find((a) => a.command === name || a.command.split('/').pop() === name) || agentList[0] || null;
}

function renderMainAgentButton() {
  const a = mainAgent();
  mainAgentBtn.hidden = !a;
  if (!a) return;
  mainAgentBtn.innerHTML = agentIcon(a);
  mainAgentBtn.dataset.command = a.command;
  mainAgentBtn.dataset.bypass = String(wantsBypass(a));
  mainAgentBtn.title = agentTitle(a);
  mainAgentBtn.setAttribute('aria-label', `${a.label} を起動`);
}

mainAgentBtn.addEventListener('click', (e) => {
  const a = mainAgent();
  if (a) launchAgent(a, wantsBypass(a, e.altKey));
});

function closeTabMenu() {
  tabMenu.hidden = true;
  tabNewBtn.setAttribute('aria-expanded', 'false');
}

function openTabMenu() {
  tabMenu.textContent = '';
  const items = [
    { label: 'ターミナル', hint: '⌘T', run: () => newTerminal() },
    ...agentList.map((a) => ({
      label: a.label,
      agent: a,
      run: (altKey) => launchAgent(a, wantsBypass(a, altKey)),
    })),
  ];
  items.forEach((item, i) => {
    if (i === 1) {
      const sep = document.createElement('div');
      sep.className = 'menu__sep';
      sep.setAttribute('role', 'separator');
      tabMenu.append(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `${item.agent ? agentIcon(item.agent) : '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8" /></svg>'}<span class="menu__label"></span>`;
    btn.querySelector('.menu__label').textContent = item.label;
    if (item.agent) {
      btn.dataset.command = item.agent.command;
      btn.title = agentTitle(item.agent);
      if (wantsBypass(item.agent)) {
        const tag = document.createElement('span');
        tag.className = 'session__bypass';
        tag.textContent = '確認なし';
        btn.append(tag);
      }
    }
    if (item.hint) {
      const hint = document.createElement('kbd');
      hint.className = 'menu__hint';
      hint.textContent = item.hint;
      btn.append(hint);
    }
    btn.addEventListener('click', (e) => {
      closeTabMenu();
      item.run(e.altKey);
    });
    tabMenu.append(btn);
  });
  // ＋ のボタンの真下に出す
  const r = tabNewBtn.getBoundingClientRect();
  const host = container.getBoundingClientRect();
  tabMenu.style.left = `${Math.max(8, r.left - host.left)}px`;
  tabMenu.hidden = false;
  tabNewBtn.setAttribute('aria-expanded', 'true');
  tabMenu.querySelector('.menu__item')?.focus();
}

tabNewBtn.addEventListener('click', () => (tabMenu.hidden ? openTabMenu() : closeTabMenu()));
// 外を押す・Esc で閉じる。上下の矢印で選ぶ
document.addEventListener('mousedown', (e) => {
  if (!tabMenu.hidden && !tabMenu.contains(e.target) && !tabNewBtn.contains(e.target)) closeTabMenu();
});
tabMenu.addEventListener('keydown', (e) => {
  const items = [...tabMenu.querySelectorAll('.menu__item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    closeTabMenu();
    tabNewBtn.focus();
  } else if (e.key === 'ArrowDown') {
    items[(i + 1) % items.length].focus();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    items[(i - 1 + items.length) % items.length].focus();
    e.preventDefault();
  }
});

// 表示中のターミナルと同じ作業場所で新しいターミナルを開き、エージェントを起動する
async function launchAgent(a, bypass) {
  const cwd = activeCwd();
  const s = await openTerminal({ cwd });
  markBypass(s, bypass);
  // シェルは起動前の入力をためておくため、すぐ送ってよい
  terp.write(s.id, agentCommandLine(a, bypass) + '\r');
  return s;
}

// 確認なしで起動したターミナルに印を付ける。開き直しても残るよう常駐のプロセスに預ける
function markBypass(s, bypass) {
  s.bypass = Boolean(bypass);
  terp.setMeta(s.id, { bypass: s.bypass });
  renderItem(s);
}

// ---- 作業の作成と削除の画面 ----

const workDialog = document.getElementById('work-dialog');
const removeDialog = document.getElementById('remove-dialog');

function setDialogError(dialog, message) {
  const el = dialog.querySelector('.dialog__error');
  el.textContent = message || '';
  el.hidden = !message;
}

function openWorkDialog(repo) {
  if (currentProjects().length === 0) {
    addProject().then((res) => res.ok && res.value && openWorkDialog(res.value));
    return;
  }
  const form = workDialog.querySelector('form');
  const select = form.elements.repo;
  const current = repo || workOf(sessions.get(activeId) || {})?.repo || currentProjects()[0].path;
  select.innerHTML = currentProjects()
    .map((p) => `<option value="${escapeHtml(p.path)}"${p.path === current ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
  const syncBase = () => (form.elements.base.value = projects.find((p) => p.path === select.value)?.base || '');
  select.onchange = syncBase;
  syncBase();
  form.elements.branch.value = '';
  // 「作ったら起動する」は、見つかったエージェントと「起動しない」から選ぶ
  form.elements.command.innerHTML = '';
  for (const a of agentList) {
    const bypass = wantsBypass(a);
    const option = new Option(`${a.command.split('/').pop()}${bypass ? '（確認なし）' : ''}`, agentCommandLine(a, bypass));
    option.dataset.bypass = String(bypass);
    form.elements.command.append(option);
  }
  form.elements.command.append(new Option('起動しない', ''));
  setDialogError(workDialog, '');
  workDialog.showModal();
  form.elements.branch.focus();
}

async function submitWork() {
  const form = workDialog.querySelector('form');
  const submit = form.querySelector('[data-action="submit"]');
  const opts = { repo: form.elements.repo.value, branch: form.elements.branch.value.trim(), base: form.elements.base.value.trim() };
  const workspace = activeWorkspace;
  if (!opts.branch || !opts.base) {
    setDialogError(workDialog, 'ブランチ名と元にするブランチを入れてください');
    return;
  }
  submit.disabled = true;
  submit.textContent = '作成中…';
  const res = await terp.createWork(opts);
  submit.disabled = false;
  submit.textContent = '作成';
  if (!res.ok) {
    setDialogError(workDialog, res.error);
    return;
  }
  workDialog.close();
  await refreshProjects();
  const s = await openTerminal({ cwd: res.value, workspace });
  // シェルは起動前の入力をためておくため、すぐ送ってよい
  const command = form.elements.command.value;
  markBypass(s, form.elements.command.selectedOptions[0]?.dataset.bypass === 'true');
  if (command) terp.write(s.id, command + '\r');
}

let removing = null;

async function openRemoveDialog(w) {
  removing = w;
  const terminals = [...sessions.values()].filter((s) => workOf(s)?.path === w.path).length;
  const res = await terp.workChanges(w.path);
  const changes = res.ok ? res.value : 0;
  removeDialog.querySelector('[data-field="branch"]').textContent = workLabel(w);
  removeDialog.querySelector('[data-field="path"]').textContent = shortPath(w.path);
  const submit = removeDialog.querySelector('[data-action="submit"]');
  const note = removeDialog.querySelector('[data-field="note"]');
  if (changes > 0) {
    note.textContent = `変更のあるファイルが ${changes} 件残っているため削除できません。コミットするか、変更を片付けてから削除してください。`;
    note.dataset.tone = 'warning';
    submit.disabled = true;
  } else {
    const closing = terminals ? `この作業のターミナル ${terminals} 枚を閉じます。` : '';
    note.textContent = `${closing}作業の場所を削除します。ブランチ ${workLabel(w)} は残ります。`;
    note.dataset.tone = '';
    submit.disabled = false;
  }
  setDialogError(removeDialog, '');
  removeDialog.showModal();
}

async function submitRemove() {
  const w = removing;
  if (!w) return;
  for (const path of [...fileViews.keys()]) {
    if (workOfPath(path)?.path === w.path && !(await closeFile(path))) return;
  }
  for (const s of [...sessions.values()]) if (workOf(s)?.path === w.path) closeSession(s.id);
  const res = await terp.removeWork({ repo: w.repo, dir: w.path });
  if (!res.ok) {
    setDialogError(removeDialog, res.error);
    return;
  }
  removeDialog.close();
  removing = null;
  refreshProjects();
}

for (const dialog of [workDialog, removeDialog]) {
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => sessions.get(activeId)?.term.focus());
}
workDialog.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitWork();
});
removeDialog.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitRemove();
});

function createItem(s) {
  const li = document.createElement('li');
  li.className = 'session';
  li.dataset.id = String(s.id);
  makeTabDraggable(li, termKey(s.id));
  li.innerHTML = `
    <span class="session__dot" role="img"></span>
    <span class="session__name"></span>
    <span class="session__key"></span>
    <span class="session__line2">
      <span class="session__bypass" title="ファイルの読み書きやコマンドの実行の確認を飛ばして起動しています" hidden>確認なし</span>
      <span class="session__sub"></span>
    </span>
    <button class="session__favorite icon-btn favorite" type="button" data-action="favorite" aria-label="お気に入りにする">${STAR_ICON}</button>
    <button class="session__close" type="button" aria-label="閉じる" title="閉じる（⌘W）">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>`;
  li.addEventListener('click', () => activate(s.id));
  li.querySelector('[data-action="favorite"]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSessionFavorite(s.id);
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    rowMenu.open([
      { label: favoriteLabel(s.favorite), run: () => toggleSessionFavorite(s.id) },
      { label: '名前を変更', run: () => startRename(s) },
      moveWorkspaceMenu(s.workspace, (id) => moveSessionWorkspace(s.id, id)),
    ], { x: e.clientX, y: e.clientY, target: li });
  });
  li.querySelector('.session__close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(s.id);
  });
  li.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    startRename(s);
  });
  looseList.appendChild(li);
  return li;
}

function startRename(s, name = s.li.querySelector('.session__name')) {
  if (!name) return;
  const input = document.createElement('input');
  input.className = name.classList.contains('pane__name') ? 'session__rename pane__rename' : 'session__rename';
  const nameClass = name.className;
  input.value = displayName(s);
  input.setAttribute('aria-label', '名前');
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      s.customName = input.value.trim() || null;
      terp.setMeta(s.id, { customName: s.customName });
    }
    const span = document.createElement('span');
    span.className = nameClass;
    input.replaceWith(span);
    renderAll();
    s.term.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
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

function hideView(key) {
  if (key.startsWith('t:')) {
    const s = sessions.get(Number(key.slice(2)));
    if (!s) return;
    s.el.hidden = true;
    detachWebgl(s);
  } else if (key.startsWith('c:')) {
    const view = commitViews.get(key);
    if (view) view.el.hidden = true;
  } else if (key.startsWith('s:')) {
    const view = subagentViews.get(key.slice(2));
    if (view) view.el.hidden = true;
  } else {
    const f = fileViews.get(key.slice(2));
    if (f) f.el.hidden = true;
  }
}

function viewOf(key) {
  if (!key) return null;
  return key.startsWith('c:') ? commitViews.get(key) : key.startsWith('t:') ? sessions.get(Number(key.slice(2))) : key.startsWith('s:') ? subagentViews.get(key.slice(2)) : fileViews.get(key.slice(2));
}

function syncPanes() {
  const displayed = new Set(paneList(layout).map((p) => p.key));
  for (const key of tabOrder) {
    const view = viewOf(key);
    if (view && !displayed.has(key)) {
      hideView(key);
      if (view.el.parentElement !== viewStore) viewStore.appendChild(view.el);
    }
  }
  panes.render(layout, activePaneId);
  for (const pane of paneList(layout)) {
    const view = viewOf(pane.key);
    if (!view) continue;
    const el = panes.body(pane.id);
    if (view.el.parentElement !== el) el.appendChild(view.el);
    view.el.hidden = false;
    if (pane.key.startsWith('t:')) {
      attachWebgl(view);
      view.fit.fit();
    } else view.view?.editor?.layout();
  }
  renderPaneTitles();
  const activePane = paneList(layout).find((p) => p.id === activePaneId);
  if (activePane && !activePane.key) panes.body(activePane.id).appendChild(empty);
  else if (empty.parentElement !== viewStore) viewStore.appendChild(empty);
  empty.hidden = Boolean(activeKey);
}

function activatePane(id, focus = true) {
  const pane = paneList(layout).find((p) => p.id === id);
  if (!pane || (id === activePaneId && !focus)) return;
  activePaneId = id;
  if (pane.key) activateKey(pane.key, focus);
  else {
    activeKey = null;
    syncPanes();
    renderAll();
    saveTabs();
  }
}

function activateKey(key, focus = true) {
  const target = viewOf(key);
  if (!target) return;
  const workspace = workspaceOfKey(key);
  if (workspace && workspace !== activeWorkspace) switchWorkspace(workspace);
  const existing = paneList(layout).find((p) => p.key === key);
  if (existing) activePaneId = existing.id;
  else layout = replacePane(layout, activePaneId, key);
  activeKey = key;
  recent = [key, ...recent.filter((k) => k !== key)];
  target.lastActive = Date.now();
  syncPanes();
  if (key.startsWith('t:')) {
    activeId = target.id;
    terp.setMeta(target.id, { lastActive: target.lastActive });
    target.unread = false;
    target.notify = false;
    updateAgentStatus(target, { type: 'seen' });
    if (focus) target.term.focus();
    target.li.scrollIntoView({ block: 'nearest' });
  } else if (focus) {
    if (target.view?.editor) target.view.editor.focus();
    else target.el.querySelector('.fileview__body, .subagent-view__body, .commit-view__body')?.focus({ preventScroll: true });
  }
  refreshGit(true);
  refreshHistory();
  refreshFiles(false);
  markActiveFile();
  renderAll();
  saveTabs();
}

function closeWorkspacePane(id) {
  if (paneList(layout).length === 1) return;
  const before = paneList(layout);
  const index = before.findIndex((p) => p.id === id);
  layout = closePane(layout, id);
  if (activePaneId === id) activePaneId = paneList(layout)[Math.max(0, index - 1)].id;
  syncPanes();
  activatePane(activePaneId);
}

function dropTargetOf(paneId) {
  const pane = paneList(layout).find((p) => p.id === paneId);
  return pathDropTarget(pane?.key, viewOf(pane?.key));
}

function dropPaths(paneId, paths, { clientX, clientY } = {}) {
  const kind = dropTargetOf(paneId);
  const valid = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path.length > 0) : [];
  if (!kind || !valid.length) return false;
  const pane = paneList(layout).find((p) => p.id === paneId);
  const view = viewOf(pane.key);
  if (kind === 'terminal') {
    activatePane(paneId);
    // paste を経由し、括弧付き貼り付けを1回の入力として届ける。
    view.term.paste(terminalPaths(valid));
  } else {
    const editor = view.view.editor;
    const target = Number.isFinite(clientX) && Number.isFinite(clientY) ? editor.getTargetAtClientPoint(clientX, clientY) : null;
    const position = target?.position || editor.getPosition();
    if (!position) return false;
    activatePane(paneId);
    editor.setPosition(position);
    editor.pushUndoStop();
    editor.executeEdits('drop-paths', [{
      range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
      text: valid.join('\n'), forceMoveMarkers: true,
    }]);
    editor.pushUndoStop();
  }
  return true;
}

async function dropTabInPane(key, paneId, side = 'center') {
  if (!['left', 'right', 'top', 'bottom', 'center'].includes(side) || typeof key !== 'string') return;
  if (!paneList(layout).some((p) => p.id === paneId)) return;
  if (!viewOf(key)) {
    if (key.startsWith('f:') && key.slice(2).startsWith('/')) await openFile(key.slice(2), { show: false });
    else if (key.startsWith('s:')) {
      for (const [id, agents] of Object.entries(subagents)) {
        const agent = agents.find((a) => a.file === key.slice(2));
        if (agent) { await openSubagent(Number(id), agent, false); break; }
      }
    }
  }
  if (!viewOf(key) || workspaceOfKey(key) !== activeWorkspace || !paneList(layout).some((p) => p.id === paneId)) return;
  // 表示中のタブを自分の枠の端へ落としたら、そのタブを新しい枠へ出し、元の枠には1つ前に見ていたタブを出す。
  // 1つ前が無ければ同じ場所で新しいターミナルを開く
  const target = paneList(layout).find((p) => p.id === paneId);
  if (side !== 'center' && target.key === key && paneList(layout).length < MAX_PANES) {
    const displayed = new Set(paneList(layout).map((p) => p.key));
    let previous = recent.find((k) => k !== key && workspaceOfKey(k) === activeWorkspace && tabOrder.includes(k) && groupOf(k) === groupOf(key) && !displayed.has(k));
    if (!previous) previous = termKey((await openTerminal({ cwd: key.startsWith('t:') ? sessions.get(Number(key.slice(2)))?.cwd : activeCwd(), show: false })).id);
    if (!paneList(layout).some((p) => p.id === paneId && p.key === key)) return;
    layout = replacePane(layout, paneId, previous);
  }
  layout = side === 'center' ? replacePane(layout, paneId, key) : splitPane(layout, paneId, key, side);
  activePaneId = paneList(layout).find((p) => p.key === key).id;
  activateKey(key);
}

async function splitRight() {
  if (paneList(layout).length >= MAX_PANES) return;
  const paneId = activePaneId;
  const s = await openTerminal({ cwd: activeCwd(), show: false });
  await dropTabInPane(termKey(s.id), paneId, 'right');
}

function movePane(side) {
  const current = panes.element(activePaneId).getBoundingClientRect();
  const horizontal = side === 'left' || side === 'right';
  const center = (r) => horizontal ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
  const cross = (r) => horizontal ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2;
  const sign = side === 'left' || side === 'top' ? -1 : 1;
  const gap = (r) => ({ left: current.left - r.right, right: r.left - current.right, top: current.top - r.bottom, bottom: r.top - current.bottom })[side];
  const candidates = paneList(layout).filter((p) => p.id !== activePaneId).map((p) => ({ ...p, rect: panes.element(p.id).getBoundingClientRect() }))
    .filter((p) => sign * (center(p.rect) - center(current)) > 0 && (horizontal
      ? Math.min(p.rect.bottom, current.bottom) > Math.max(p.rect.top, current.top)
      : Math.min(p.rect.right, current.right) > Math.max(p.rect.left, current.left)))
    .sort((a, b) => (gap(a.rect) - gap(b.rect)) || (Math.abs(cross(a.rect) - cross(current)) - Math.abs(cross(b.rect) - cross(current))));
  if (candidates[0]) activatePane(candidates[0].id);
}

function activate(id) {
  activateKey(termKey(id));
}

// ---- タブで開くファイル ----

function savedTabState() {
  rememberWorkspace();
  const persistent = (key) => key && !key.startsWith('s:') && !key.startsWith('c:');
  const order = tabOrder.filter(persistent);
  const states = Object.fromEntries(workspaces.map(({ id }) => {
    const state = workspaceStates.get(id) || {};
    const keys = order.filter((key) => workspaceOfKey(key) === id);
    return [id, { ...state, active: keys.includes(state.active) ? state.active : null,
      layout: state.layout ? restoreLayout(state.layout, keys) : null,
      recent: recent.filter((key) => keys.includes(key)) }];
  }));
  const active = persistent(activeKey) ? activeKey : recent.find((key) => persistent(key) && workspaceOfKey(key) === activeWorkspace) || null;
  return { files: [...fileViews.keys()], order, active, layout: restoreLayout(layout, order), workspaces: states,
    fileWorkspaces: Object.fromEntries([...fileViews].map(([path, view]) => [path, view.workspace])) };
}

function saveTabs() {
  if (restoringTabs) return;
  clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(() => terp.saveTabs(savedTabState()), 250);
}

async function restoreTabs() {
  const res = await terp.loadTabs().catch(() => ({ ok: false }));
  const remap = (key) => restoredKeys.get(key) || key;
  const remapLayout = (node, depth = 0) => !node || typeof node !== 'object' || depth > 20 ? null
    : node.type === 'pane' ? { ...node, key: remap(node.key) }
    : { ...node, children: Array.isArray(node.children) ? node.children.map((child) => remapLayout(child, depth + 1)) : [] };
  if (res.ok) {
    const data = res.value;
    const legacyWorkspace = workspaces.find((w) => w.id === 'default')?.id || workspaces[0].id;
    for (const path of data.files) {
      const workspace = workspaces.some((w) => w.id === data.fileWorkspaces?.[path]) ? data.fileWorkspaces[path] : legacyWorkspace;
      await openFile(path, { show: false, workspace });
    }
    const remaining = new Set(tabOrder);
    tabOrder = [...data.order.map(remap).filter((key) => remaining.delete(key)), ...remaining];
    workspaceStates.clear();
    const states = data.workspaces || { [legacyWorkspace]: { active: data.active, layout: data.layout } };
    for (const { id } of workspaces) {
      const saved = states[id];
      if (!saved) continue;
      workspaceStates.set(id, { ...saved, active: remap(saved.active), layout: remapLayout(saved.layout),
        activeId: saved.activeId ? Number(remap(termKey(saved.activeId)).slice(2)) : null });
    }
    recent = [...new Set(Object.values(states).flatMap((state) => (Array.isArray(state.recent) ? state.recent : []).map(remap)).filter((key) => tabOrder.includes(key)))];
  }
  showWorkspaceState(activeWorkspace);
  restoringTabs = false;
  saveTabs();
}

async function openFile(path, { line, column, show = true, workspace = activeWorkspace } = {}) {
  const key = fileKey(path);
  if (fileViews.has(path)) {
    const f = fileViews.get(path);
    if (show) activateKey(key);
    await f.view.ready;
    if (line !== undefined && activeKey === key) f.view.reveal(line, column);
    return f;
  }
  const el = document.createElement('section');
  el.className = 'fileview';
  el.hidden = true;
  viewStore.appendChild(el);
  const f = { path, el, workspace, lastActive: Date.now() };
  fileViews.set(path, f);
  // 表示中のタブの隣に開く
  const at = tabOrder.indexOf(activeKey);
  tabOrder.splice(at < 0 ? tabOrder.length : at + 1, 0, key);
  if (show) activateKey(key);
  f.view = renderFileView(el, path, workOfPath(path, workspace)?.path || null, {
    confirm: confirmFile,
    onChange: () => renderTabs(visibleKeys()),
    isActive: () => activeKey === key,
    onHistory: (file) => { filterFileHistory(file); setPanel('history'); },
  });
  await f.view.ready;
  if (line !== undefined && activeKey === key) f.view.reveal(line, column);
  return f;
}

function closeKey(key) {
  if (!key) return;
  if (key.startsWith('t:')) closeSession(Number(key.slice(2)));
  else if (key.startsWith('c:')) {
    const view = commitViews.get(key);
    if (!view) return;
    view.view.dispose();
    view.el.remove();
    dropTab(key);
    commitViews.delete(key);
  } else if (key.startsWith('s:')) {
    const view = subagentViews.get(key.slice(2));
    if (!view) return;
    // 所属を求められるうちに次のタブへ移る
    view.el.remove();
    dropTab(key);
    subagentViews.delete(key.slice(2));
  } else return closeFile(key.slice(2));
}

function closeFile(path) {
  const f = fileViews.get(path);
  if (!f) return Promise.resolve(true);
  if (!f.closing) f.closing = closeFileView(f).finally(() => { f.closing = null; });
  return f.closing;
}

async function closeFileView(f) {
  if (f.view.saving) await f.view.saving;
  if (f.view.dirty) {
    const answer = await confirmFile({
      title: 'ファイルを閉じる', message: `${f.path} に未保存の変更あり`,
      accept: '保存して閉じる', discard: '保存せずに閉じる',
    });
    if (answer === 'cancel' || (answer === 'accept' && !(await f.view.save()))) return false;
  }
  f.view.dispose();
  f.el.remove();
  dropTab(fileKey(f.path));
  fileViews.delete(f.path);
  return true;
}

// 閉じる確認の後に上書き確認が続いても、同じ部品で順に表示する
let fileQuestions = Promise.resolve();
function confirmFile({ title, message, accept, discard }) {
  const question = fileQuestions.then(() => new Promise((resolve) => {
    const dialog = document.getElementById('file-dialog');
    dialog.querySelector('.dialog__title').textContent = title;
    dialog.querySelector('[data-field="message"]').textContent = message;
    dialog.querySelector('[value="accept"]').textContent = accept;
    const discardButton = dialog.querySelector('[value="discard"]');
    discardButton.hidden = !discard;
    discardButton.textContent = discard || '';
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => {
      resolve(['accept', 'discard'].includes(dialog.returnValue) ? dialog.returnValue : 'cancel');
      const f = activeKey?.startsWith('f:') && fileViews.get(activeKey.slice(2));
      if (f?.view.editor) f.view.editor.focus();
      else if (activeKey?.startsWith('t:')) sessions.get(activeId)?.term.focus();
    }, { once: true });
    dialog.showModal();
  }));
  fileQuestions = question.catch(() => {});
  return question;
}

let closingWindow = false;
terp.onCloseRequest(async (id) => {
  if (closingWindow) return;
  closingWindow = true;
  // 応答と確認の結果を分け、考えている間に2秒の期限で閉じないようにする
  terp.replyClose(id, 'pending');
  let allow = false;
  try {
    await Promise.allSettled([...fileViews.values()].map((f) => f.view?.saving));
    const dirty = [...fileViews.values()].filter((f) => f.view?.dirty);
    if (dirty.length === 0) allow = true;
    else {
      const answer = await confirmFile({
        title: 'terp を終了', message: `${dirty.length} 件のファイルに未保存の変更あり`,
        accept: 'すべて保存して終了', discard: '保存せずに終了',
      });
      if (answer === 'discard') allow = true;
      else if (answer === 'accept') {
        allow = true;
        for (const f of fileViews.values()) {
          if (f.view?.dirty && !(await f.view.save())) { allow = false; break; }
        }
        if ([...fileViews.values()].some((f) => f.view?.dirty)) allow = false;
      }
    }
  } finally {
    if (allow && !restoringTabs) {
      clearTimeout(saveTabsTimer);
      await terp.saveTabs(savedTabState()).catch(() => {});
    }
    terp.replyClose(id, allow);
    closingWindow = false;
  }
});

// 閉じたタブの枠は、同じ作業の未表示のタブで埋める。
function dropTab(key, group = groupOf(key)) {
  tabOrder = tabOrder.filter((k) => k !== key);
  recent = recent.filter((k) => k !== key);
  const pane = paneList(layout).find((p) => p.key === key);
  if (pane) {
    const displayed = new Set(paneList(layout).map((p) => p.key));
    const next = recent.find((k) => workspaceOfKey(k) === activeWorkspace && tabOrder.includes(k) && groupOf(k) === group && !displayed.has(k));
    if (next) layout = replacePane(layout, pane.id, next);
    else layout = closePane(layout, pane.id);
  }
  if (!paneList(layout).some((p) => p.id === activePaneId)) activePaneId = paneList(layout)[0].id;
  activeKey = paneList(layout).find((p) => p.id === activePaneId).key;
  syncPanes();
  if (activeKey) activateKey(activeKey);
  else { renderAll(); saveTabs(); }
}

// ---- コミットの詳細 ----

function openCommit(top, hash, subject = '') {
  const key = `c:${top}@${hash}`;
  if (commitViews.has(key)) { activateKey(key); return; }
  const el = document.createElement('section');
  el.className = 'commit-view';
  el.hidden = true;
  const view = { top, hash, subject, el, workspace: activeWorkspace };
  commitViews.set(key, view);
  viewStore.append(el);
  const at = tabOrder.indexOf(activeKey);
  tabOrder.splice(at < 0 ? tabOrder.length : at + 1, 0, key);
  view.view = renderCommitView(el, top, hash, {
    openCommit,
    onLoad: (info) => { view.subject = info.subject; renderTabs(visibleKeys()); },
  });
  activateKey(key);
}

// ---- 右の面（ファイル・変更・履歴） ----

let panelTab = null;

function setPanel(tab) {
  panelTab = tab;
  rightPanel.hidden = !tab;
  setFilesVisible(tab === 'files');
  setGitVisible(tab === 'git');
  setHistoryVisible(tab === 'history');
  for (const [id, name] of [['panel-tab-files', 'files'], ['panel-tab-git', 'git'], ['files-toggle', 'files'], ['git-toggle', 'git'], ['panel-tab-history', 'history'], ['history-toggle', 'history']]) {
    const el = document.getElementById(id);
    el.setAttribute(el.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', String(tab === name));
  }
  // 面の幅のぶん端末の幅が変わるため、表示中の端末を合わせ直させる
  window.dispatchEvent(new Event('resize'));
  if (!tab) sessions.get(activeId)?.term.focus();
}

// 上の帯のボタン: 閉じていれば開き、同じ切り替え先が開いていれば閉じる
function togglePanel(tab) {
  setPanel(panelTab === tab ? null : tab);
}

function handleKey(s, event) {
  if (event.type !== 'keydown') return true;
  // claude の改行。VS Code の /terminal-setup と同じく ESC + CR を送る。
  // 既定の動きを止めないと続く keypress を xterm.js が Enter として扱い、CR も送って実行してしまう
  if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    updateAgentStatus(s, { type: 'input' });
    terp.write(s.id, '\x1b\r');
    renderAll();
    return false;
  }
  if (event.key === 'Tab' && event.ctrlKey) {
    event.preventDefault();
    switchRecent();
    return false;
  }
  // 行の編集のキーは iTerm2 の「自然な文字編集」・Terminal.app と同じ信号にする。
  // xterm.js は ⌥← を ESC[1;3D で送るが、zsh・bash・claude はこれを単語の移動として受け取らない
  const sequence = editingSequence(event);
  if (sequence) {
    event.preventDefault();
    updateAgentStatus(s, { type: 'input' });
    terp.write(s.id, sequence);
    return false;
  }
  // ⌘ の付くキーはメニュー（main.js）が受け取る
  return !event.metaKey;
}

// ⌥←→ は単語の移動（ESC b / ESC f）、⌘←→ は行の頭と末尾（^A / ^E）、⌘⌫ は行の頭まで消す（^U）
function editingSequence(event) {
  if (event.shiftKey || event.ctrlKey) return null;
  if (event.altKey && !event.metaKey) return { ArrowLeft: '\x1bb', ArrowRight: '\x1bf' }[event.key] || null;
  if (event.metaKey && !event.altKey) return { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' }[event.key] || null;
  return null;
}

function buildTerminal() {
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  container.appendChild(el);

  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    fontFamily: config.font.family,
    fontSize: config.font.size,
    minimumContrastRatio: config.minimumContrast,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
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
  // 寸法を測れるよう、一度表示してから測る
  el.hidden = false;
  fit.fit();
  el.hidden = true;
  return { el, term, fit };
}

function registerSession(id, { el, term, fit }, extra = {}) {
  const s = {
    id,
    term,
    fit,
    el,
    cwd: '',
    program: '',
    title: '',
    customName: null,
    workspace: activeWorkspace,
    favorite: false,
    agentTitle: '',
    ...reduceAgentStatus({}, { type: 'reset' }, Date.now()),
    createdAt: Date.now(),
    lastOutput: 0,
    unread: false,
    notify: false,
    webgl: null,
    // つなぎ直しの途中に届いた出力。残りの出力を書いてから流す
    pending: null,
    ...extra,
  };
  sessions.set(id, s);
  s.pathLinks = createPathLinkProvider(term, {
    context: () => ({ cwd: s.cwd, root: workOf(s)?.path, home: terp.home }),
    statFile: (path) => terp.statFile(path),
    openFile,
    revealFile: (path) => terp.revealFile(path),
  });
  term.registerLinkProvider(s.pathLinks);
  s.li = createItem(s);

  term.attachCustomKeyEventHandler((event) => handleKey(s, event));
  term.onData((data) => {
    updateAgentStatus(s, { type: 'input' });
    terp.write(id, data);
    renderAll();
  });
  term.onResize(({ cols, rows }) => terp.resize(id, cols, rows));
  term.onTitleChange((title) => {
    s.title = title;
    const { working, text } = parseTitle(title);
    if (text) s.agentTitle = text;
    // 作業中から入力待ちに変わったら、応答が終わったことを知らせる
    const finished = s.agentWorking && !working;
    updateAgentStatus(s, { type: 'title', working });
    if (finished) markNotify(s, 'done');
    terp.setMeta(id, { title, agentTitle: s.agentTitle });
    renderItem(s);
  });
  term.onBell(() => markNotify(s, 'bell'));
  // OSC 9 / 777 は claude などが「入力待ち」を知らせるのに使う
  for (const osc of [9, 777]) term.parser.registerOscHandler(osc, (data) => {
    const message = notificationOsc(osc, data);
    if (message !== null) markNotify(s, 'done', message);
    return true;
  });
  new ResizeObserver(() => {
    if (!el.hidden) fit.fit();
  }).observe(el);
  return s;
}

async function openTerminal({ cwd, show = true, workspace = activeWorkspace, favorite = false } = {}) {
  const view = buildTerminal();
  const { id, cwd: startCwd } = await terp.createPty({ cols: view.term.cols, rows: view.term.rows, cwd, workspace });
  const s = registerSession(id, view, { cwd: startCwd, workspace, favorite });
  terp.setMeta(id, { workspace, favorite });
  tabOrder.push(termKey(id));
  if (show) activate(id);
  else renderAll();
  return s;
}

// 常駐のプロセスに残っているシェルへつなぎ直す。残っていた出力を流して画面を作り直す
async function attachTerminal(e) {
  const view = buildTerminal();
  const s = registerSession(e.id, view, {
    cwd: e.cwd,
    workspace: e.meta.workspace,
    favorite: Boolean(e.meta.favorite),
    customName: e.meta.customName || null,
    title: e.meta.title || '',
    agentTitle: e.meta.agentTitle || '',
    lastActive: e.meta.lastActive || 0,
    bypass: Boolean(e.meta.bypass),
    pending: [],
  });
  tabOrder.push(termKey(e.id));
  const res = await terp.attach(e.id);
  // 流し直す出力に残ったベルや OSC 9 で、開き直すたびに通知が出ないようにする
  if (res.replay) {
    s.replaying = true;
    s.term.write(res.replay, () => { s.replaying = false; });
  }
  for (const data of s.pending) s.term.write(data);
  s.pending = null;
  // 大きさを一度変えて戻し、claude などの全画面のプログラムに描き直させる
  const { cols, rows } = s.term;
  terp.resize(e.id, Math.max(cols - 1, 2), rows);
  setTimeout(() => terp.resize(e.id, cols, rows), 80);
  return s;
}

// 起動したとき: 生きているシェルがあればつなぎ直す。無ければ前回の控えから開き直し、
// claude の会話は --resume で再開する。どちらも無ければ1枚開く
async function restoreSessions() {
  const { existing, snapshot } = await terp.restoreInfo();
  if (existing.length > 0) {
    const restored = [];
    for (const e of existing.sort((a, b) => a.id - b.id)) restored.push(await attachTerminal(e));
    const inWorkspace = restored.filter((s) => s.workspace === activeWorkspace);
    if (inWorkspace.length) activate(inWorkspace.reduce((a, b) => b.lastActive > a.lastActive ? b : a, inWorkspace[0]).id);
    return;
  }
  if (snapshot.length > 0) {
    for (const snap of snapshot) {
      const s = await openTerminal({ cwd: snap.cwd, workspace: snap.workspace, favorite: Boolean(snap.favorite), show: false });
      if (snap.id) restoredKeys.set(termKey(snap.id), termKey(s.id));
      if (snap.customName) {
        s.customName = snap.customName;
        terp.setMeta(s.id, { customName: snap.customName });
      }
      // シェルは起動前の入力をためておくため、すぐ送ってよい
      if (snap.claudeSession) terp.write(s.id, `claude --resume ${snap.claudeSession}\r`);
    }
    renderAll();
    return;
  }
  await openTerminal();
}

// DOM や時計を参照せず、端末から来た文字と通知の条件を検査する
function notificationOsc(osc, data) {
  if (osc === 9) return data.startsWith('4;') ? null : data;
  if (osc !== 777 || !data.startsWith('notify;')) return null;
  const separator = data.indexOf(';', 7);
  return separator < 0 ? '' : data.slice(separator + 1);
}

function notificationText(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

function notificationPayload({ kind, message = '', title, context, config, focused, visible, lastAt, now }) {
  if (!config.notifications || !(kind === 'done' ? config.notifyAgentDone : kind === 'bell' && config.notifyBell)) return null;
  if (!config.notifyWhenVisible && focused && visible) return null;
  if (lastAt !== undefined && now - lastAt < 3000) return null;
  const text = notificationText(message) || (kind === 'done' ? '応答が終わった' : 'ベルが鳴った');
  const place = notificationText(context);
  return {
    title: notificationText(title) + (place ? ` · ${place}` : ''),
    body: Array.from(text + (place ? ` · ${place}` : '')).slice(0, 200).join(''),
  };
}

function markNotify(s, kind, message = '') {
  if (s.replaying) return;
  const focused = focusForTest ?? document.hasFocus();
  const w = workOf(s);
  const now = Date.now();
  if (kind === 'done') updateAgentStatus(s, { type: 'notification', message, seen: focused && terminalVisible(s) }, now);
  const payload = notificationPayload({
    kind, message, title: displayName(s),
    context: w ? `${w.repo.split('/').pop()} / ${workLabel(w)}` : shortPath(s.cwd),
    config, focused,
    visible: paneList(layout).some((p) => p.key === termKey(s.id)),
    lastAt: s.lastNotifyAt, now,
  });
  if (payload && !s.replaying) {
    s.lastNotifyAt = now;
    terp.showNotification({ id: s.id, kind, ...payload }).then((res) => {
      if (!res.ok) console.error(res.error);
    });
  }
  if (!(activeKey === termKey(s.id) && focused)) s.notify = true;
  renderAll();
}

function closeSession(id) {
  terp.kill(id);
}

function removeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  // 所属の作業を先に求める（消した後は求められない）
  const key = termKey(id);
  const group = groupOf(key);
  for (const view of subagentViews.values()) {
    if (view.sessionId !== id) continue;
    view.cwd = s.cwd;
    view.workspace = s.workspace;
    view.agent = { ...view.agent, running: false };
    updateSubagentHeading(view);
    readSubagentView(view);
  }
  subagentLists.get(id)?.el.remove();
  subagentLists.delete(id);
  delete subagents[id];
  detachWebgl(s);
  s.term.dispose();
  s.el.remove();
  s.li.remove();
  sessions.delete(id);
  if (activeId === id) activeId = null;
  dropTab(key, group);
}

function switchRecent() {
  const inWorkspace = recent.filter((key) => workspaceOfKey(key) === activeWorkspace);
  if (inWorkspace.length > 1) activateKey(inWorkspace[1]);
}

function switchOffset(offset) {
  const order = visibleKeys();
  if (order.length === 0) return;
  const index = order.indexOf(activeKey);
  activateKey(order[(index + offset + order.length) % order.length]);
}

function newTerminal() {
  return openTerminal({ cwd: activeCwd() });
}

terp.onData((id, data) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.pending) {
    s.pending.push(data);
    return;
  }
  updateAgentStatus(s, { type: 'output', replaying: s.replaying });
  s.term.write(data);
  s.lastOutput = Date.now();
  if (activeKey !== termKey(id)) s.unread = true;
});

terp.onExit((id) => removeSession(id));
terp.onConfig(applyConfig);
// 全画面のときだけ、窓の後ろに壁紙を敷く（本体の wallpaper.js）。透過していないときは出さない
const wallpaperEl = document.createElement('div');
wallpaperEl.id = 'wallpaper';
wallpaperEl.hidden = true;
document.body.prepend(wallpaperEl);
let wallpaperUrl = null;
function showWallpaper() {
  wallpaperEl.style.backgroundImage = wallpaperUrl ? `url("${wallpaperUrl}")` : '';
  wallpaperEl.hidden = !wallpaperUrl || config.window.opacity >= 1;
}
terp.onWallpaper((url) => {
  wallpaperUrl = url;
  showWallpaper();
});
terp.onNotification((id) => {
  if (sessions.has(id)) activateKey(termKey(id));
});
terp.onHostStale(() => {
  const notice = document.getElementById('host-notice');
  notice.hidden = false;
});

terp.onInfo((info) => {
  for (const { id, cwd, program } of info) {
    const s = sessions.get(id);
    if (!s) continue;
    s.cwd = cwd;
    if (isAgent(s) && s.program !== program) updateAgentStatus(s, { type: 'reset' });
    s.program = program;
  }
  refreshHistory();
  renderAll();
});

terp.onMenu((action, arg) => {
  if (action === 'overview') { overview.toggle(); return; }
  if (overview.open) {
    if (action === 'select-all') overview.selectAll();
    return;
  }
  // ファイルのタブを表示している間は、端末向けの操作（消去・すべて選択）を端末に向けない
  const s = activeKey?.startsWith('t:') ? sessions.get(activeId) : null;
  switch (action) {
    case 'workspace-index':
      if (workspaces[arg]) switchWorkspace(workspaces[arg].id);
      break;
    case 'workspace-next':
    case 'workspace-prev': {
      const at = workspaces.findIndex((w) => w.id === activeWorkspace);
      switchWorkspace(workspaces[(at + (action === 'workspace-next' ? 1 : -1) + workspaces.length) % workspaces.length].id);
      break;
    }
    case 'next-attention':
      nextAttention();
      break;
    case 'new':
      newTerminal();
      break;
    case 'split-right':
      splitRight();
      break;
    case 'pane-left':
    case 'pane-right':
    case 'pane-up':
    case 'pane-down':
      movePane(action.slice(5).replace('up', 'top').replace('down', 'bottom'));
      break;
    case 'close':
      closeKey(activeKey);
      break;
    case 'save':
      if (activeKey?.startsWith('f:')) fileViews.get(activeKey.slice(2))?.view?.save();
      break;
    case 'clear':
      s?.term.clear();
      break;
    case 'select-all': {
      const editor = activeKey?.startsWith('f:') && fileViews.get(activeKey.slice(2))?.view?.editor;
      if (editor?.hasTextFocus()) editor.setSelection(editor.getModel().getFullModelRange());
      else if (!s || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) document.execCommand('selectAll');
      else s.term.selectAll();
      break;
    }
    case 'select-index': {
      const key = visibleKeys()[arg];
      if (key) activateKey(key);
      break;
    }
    case 'recent':
      switchRecent();
      break;
    case 'new-work':
      openWorkDialog();
      break;
    case 'toggle-history':
      togglePanel('history');
      break;
    case 'toggle-git':
      togglePanel('git');
      break;
    case 'toggle-files':
      togglePanel('files');
      break;
    case 'settings':
      openSettings();
      break;
    case 'add-project':
      addProject();
      break;
    case 'prev':
      switchOffset(-1);
      break;
    case 'next':
      switchOffset(1);
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.target.closest('.xterm')) return;
  if (document.querySelector('dialog[open]') || event.target.closest('.menu')) return;
  if (event.target.closest('input, textarea') && !event.target.closest('.fileview')) return;
  event.preventDefault();
  event.stopPropagation();
  switchRecent();
}, true);

document.getElementById('new-terminal').addEventListener('click', () => newTerminal());
document.getElementById('files-toggle').addEventListener('click', () => togglePanel('files'));
document.getElementById('history-toggle').addEventListener('click', () => togglePanel('history'));
document.getElementById('panel-tab-history').addEventListener('click', () => setPanel('history'));
document.getElementById('git-toggle').addEventListener('click', () => togglePanel('git'));
document.getElementById('panel-tab-files').addEventListener('click', () => setPanel('files'));
document.getElementById('panel-tab-git').addEventListener('click', () => setPanel('git'));
document.getElementById('panel-close').addEventListener('click', () => setPanel(null));
document.getElementById('panel-refresh').addEventListener('click', () => (panelTab === 'files' ? refreshFiles(true) : panelTab === 'history' ? refreshHistory('refresh') : refreshGit(true)));
document.getElementById('empty-new').addEventListener('click', () => newTerminal());
document.getElementById('new-work').addEventListener('click', () => openWorkDialog());
document.getElementById('add-project').addEventListener('click', () => addProject());
document.getElementById('settings-open').addEventListener('click', () => openSettings());
document.getElementById('empty-add-project').addEventListener('click', () => addProject());

// 外で作った worktree や変更の数を拾うため、定期的に git から読み直す
setInterval(refreshProjects, 5000);
setInterval(refreshSubagents, 3000);
window.addEventListener('focus', refreshSubagents);
window.addEventListener('focus', refreshProjects);
// エージェントを入れたり消したりしたら、ウィンドウに戻ったときに拾い直す
window.addEventListener('focus', refreshAgents);

// 出力中の印を時間で消すため、状態だけ定期的に描き直す
setInterval(renderAll, 500);
setInterval(() => {
  for (const f of fileViews.values()) f.view?.checkExternal().catch(() => {});
  for (const view of subagentViews.values()) if (view.agent.running || view.offset === undefined || view.readError) readSubagentView(view);
}, 2000);

// 自己診断（TERP_SELFTEST）から操作するための口
window.__terp = {
  setFocusForTest: (focused) => { focusForTest = focused; },
  sessions,
  get workspaces() { return workspaces; },
  get activeWorkspace() { return activeWorkspace; },
  switchWorkspace,
  createWorkspace,
  removeWorkspace,
  moveProjectWorkspace,
  moveSessionWorkspace,
  toggleProjectFavorite,
  toggleSessionFavorite,
  workspaceDeleteReason,
  nextAttention,
  stateOf,
  renderAll,
  layout: () => structuredClone(layout),
  dropTab: dropTabInPane,
  dropPaths,
  get activePaneId() { return activePaneId; },
  get activeId() {
    return activeId;
  },
  open: (cwd) => openTerminal({ cwd }).then((s) => s.id),
  activate,
  activateKey,
  // 自己診断へは関数を含むものを渡せないため、開いたパスだけを返す
  openFile: (path, position) => openFile(path, position).then(() => path),
  editorOf: (path) => fileViews.get(path)?.view?.editor || null,
  terminalLinks: async (id) => (await sessions.get(id).pathLinks.visibleLinks()).map(({ text, path, line, column, range, directory }) => ({ text, path, line, column, range, directory })),
  activateTerminalLink: (id, text) => sessions.get(id).pathLinks.activate(text),
  closeKey,
  setPanel,
  openSettings,
  get activeKey() {
    return activeKey;
  },
  get tabOrder() {
    return tabOrder;
  },
  visibleKeys,
  get config() {
    return config;
  },
  get projects() {
    return projects;
  },
  addProject,
  refreshProjects,
  refreshSubagents,
  refreshAgents,
  get agents() {
    return agentList;
  },
  get registry() {
    return agentRegistry;
  },
  rename(id, name) {
    const s = sessions.get(id);
    s.customName = name;
    terp.setMeta(id, { customName: name });
    renderItem(s);
  },
  openWorkDialog,
  openRemoveDialog,
  workOf: (id) => workOf(sessions.get(id))?.path || null,
  bufferText,
};

applyConfig(config);
initGitPanel({ activeCwd });
initHistoryPanel({ activeCwd, openCommit });
initSettings({
  agents: () => agentList,
  registry: () => agentRegistry,
  refreshAgents,
  onClose: () => (activeKey?.startsWith('t:') ? sessions.get(activeId)?.term.focus() : null),
});
initFilesPanel({
  activeCwd,
  activePath: () => (activeKey?.startsWith('f:') ? activeKey.slice(2) : null),
  openFile,
});
await refreshProjects();
noProjects.hidden = currentProjects().length > 0;
await refreshAgents();
// つなぎ直しに失敗しても、ファイルのタブは開き直し、控えの書き込みを止めたままにしない
try {
  await restoreSessions();
} finally {
  await restoreTabs();
}
await refreshSubagents();
