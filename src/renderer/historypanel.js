// 右の履歴の一覧と、作業画面に開くコミットの詳細
import { renderDiff } from './gitpanel.js';
import { buildHistoryGraph, GRAPH_COLORS } from './historygraph.js';
const terp = window.terp;
const panel = document.getElementById('history-view');
const list = document.getElementById('history-list');
const scroll = document.getElementById('history-scroll');
const status = document.getElementById('history-status');
const retry = document.getElementById('history-retry');
const more = document.getElementById('history-more');
const work = document.getElementById('history-work');
const scope = document.getElementById('history-scope');
const query = document.getElementById('history-query');
const pathFilter = document.getElementById('history-path-filter');
const pathLabel = document.getElementById('history-path');
let getCwd = () => null;
let openCommit = () => {};
let visible = false;
let state = null;
let fileFilter = null;
let serial = 0;
let debounce = null;
let loading = false;
let pendingCwd = null;

export function initHistoryPanel({ activeCwd, openCommit: open }) {
  getCwd = activeCwd;
  openCommit = open;
  scope.addEventListener('change', reset);
  query.addEventListener('input', () => {
    // 打っている間に前の検索が戻っても、古い結果を描かない
    serial++;
    clearTimeout(debounce);
    if (!query.composing) debounce = setTimeout(reset, 300);
  });
  query.addEventListener('compositionstart', () => { query.composing = true; clearTimeout(debounce); serial++; });
  query.addEventListener('compositionend', () => { query.composing = false; clearTimeout(debounce); debounce = setTimeout(reset, 300); });
  document.getElementById('history-path-clear').addEventListener('click', () => { fileFilter = null; reset(); });
  retry.addEventListener('click', () => refreshHistory('refresh'));
  more.addEventListener('click', () => refreshHistory('more'));
  setInterval(() => { if (!loading && !debounce) refreshHistory('refresh'); }, 10000);
}

export function setHistoryVisible(open) {
  const changed = visible !== open;
  visible = open;
  panel.hidden = !open;
  if (changed) serial++;
  if (open) refreshHistory('refresh');
}

export function filterFileHistory(file) {
  fileFilter = { file, top: null };
  query.value = '';
  clearTimeout(debounce);
  debounce = null;
  state = null;
  list.replaceChildren();
  more.hidden = true;
  serial++;
}

function reset() {
  clearTimeout(debounce);
  debounce = null;
  state = null;
  list.replaceChildren();
  more.hidden = true;
  serial++;
  refreshHistory('refresh');
}

function showPath() {
  pathFilter.hidden = !fileFilter;
  pathLabel.textContent = fileFilter ? `ファイル: ${fileFilter.top && fileFilter.file.startsWith(fileFilter.top + '/') ? fileFilter.file.slice(fileFilter.top.length + 1) : fileFilter.file}` : '';
  pathLabel.title = fileFilter?.file || '';
}

export async function refreshHistory(mode = 'context') {
  if (!visible) return;
  const cwd = getCwd();
  if (mode === 'context' && (state?.cwd === cwd || (loading && pendingCwd === cwd))) return;
  if (mode === 'more' && (!state?.hasMore || loading)) return;
  const request = ++serial;
  const current = () => request === serial && visible;
  loading = true;
  pendingCwd = cwd;
  panel.setAttribute('aria-busy', 'true');
  more.disabled = true;
  status.textContent = list.childElementCount ? '' : '履歴を読み込み中…';
  retry.hidden = true;
  showPath();
  try {
    let res;
    // 場所が変わったときは、前のファイルの絞り込みを渡す前に所属を確認する
    if (!state || state.cwd !== cwd) {
      res = cwd ? await terp.historyLog({ dir: cwd, limit: 100, all: scope.value === 'all' }) : { ok: true, value: null };
      if (!current()) return;
      if (!res.ok) throw new Error(res.error);
      if (!res.value) {
        state = null;
        fileFilter = null;
        work.textContent = '';
        list.replaceChildren();
        more.hidden = true;
        status.textContent = 'git のリポジトリではありません';
        showPath();
        return;
      }
      const top = res.value.top;
      const changed = state?.top !== top;
      if (fileFilter?.top && fileFilter.top !== top) fileFilter = null;
      if (fileFilter && !fileFilter.top) {
        if (fileFilter.file.startsWith(top + '/')) fileFilter.top = top;
        else fileFilter = null;
      }
      if (changed) {
        state = { cwd, top, rows: [], hasMore: false, nextSkip: null };
        list.replaceChildren();
        scroll.scrollTop = 0;
      } else state.cwd = cwd;
      if (!fileFilter && !query.value.trim() && (changed || state.rows.filter((r) => r.commit).length <= 100)) {
        apply(res.value, false);
        return;
      }
    }
    const count = state.rows.filter((r) => r.commit).length;
    const append = mode === 'more';
    res = await terp.historyLog({
      dir: state.top, limit: append ? 100 : Math.max(100, count), skip: append ? state.nextSkip : 0,
      all: scope.value === 'all', path: fileFilter?.file || null, query: query.value,
    });
    if (!current()) return;
    if (!res.ok) throw new Error(res.error);
    if (!res.value) throw new Error('git のリポジトリが見つからない');
    apply(res.value, append);
  } catch (err) {
    if (!current()) return;
    status.textContent = `履歴を読めない: ${err.message}`;
    retry.hidden = false;
  } finally {
    if (current()) { loading = false; pendingCwd = null; more.disabled = false; panel.setAttribute('aria-busy', 'false'); }
  }
}

function apply(value, append) {
  const previous = scroll.scrollTop;
  const anchor = [...list.querySelectorAll('[data-hash]')].find((row) => row.offsetTop + row.offsetHeight > previous);
  const offset = anchor ? anchor.offsetTop - previous : 0;
  const focused = document.activeElement?.closest('#history-list [data-hash]')?.dataset.hash;
  state = { ...state, ...value, rows: append ? [...state.rows, ...value.rows] : value.rows };
  work.textContent = value.top.split('/').pop();
  work.title = value.top;
  showPath();
  renderRows();
  more.hidden = !value.hasMore;
  status.textContent = state.rows.some((r) => r.commit) ? '' : '当たるコミットがない。条件を変えて読み直す';
  if (focused) list.querySelector(`[data-hash="${focused}"]`)?.focus({ preventScroll: true });
  const nextAnchor = anchor && list.querySelector(`[data-hash="${anchor.dataset.hash}"]`);
  scroll.scrollTop = nextAnchor ? nextAnchor.offsetTop - offset : previous;
}

function element(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svgElement(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const GITHUB_PATH = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

function refIcon(kind) {
  const svg = svgElement('svg', { class: 'icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', 'data-icon': kind });
  // GitHub の印は Octicons の mark-github（MIT）を使用する
  const paths = {
    github: GITHUB_PATH,
    check: 'M3 8l3 3 7-7',
    tag: 'M2 2h6l6 6-6 6-6-6Z M5 5h.01',
    cloud: 'M4.5 12h7a3 3 0 0 0 .5-6 4 4 0 0 0-7.7-.5A3.3 3.3 0 0 0 4.5 12Z',
  };
  svg.append(svgElement('path', { d: paths[kind], fill: kind === 'github' ? 'currentColor' : 'none', stroke: kind === 'github' ? 'none' : 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

function graphColor(color) {
  const name = GRAPH_COLORS[color % GRAPH_COLORS.length];
  return name === 'accent' ? 'var(--color-accent)' : `var(--history-${name}, var(--color-accent))`;
}

function badges(refs, color = 'var(--color-accent)', remotes = {}) {
  const el = element('span', 'history__refs');
  // 詳細タブの印は従来の文字列をそのまま表示する
  if (typeof refs === 'string') {
    for (const ref of refs.split(', ').filter(Boolean)) el.append(element('span', 'work__tag', ref));
    return el;
  }
  const names = Object.keys(remotes).sort((a, b) => b.length - a.length);
  const remoteOf = (ref) => names.find((name) => ref.name.startsWith(name + '/'));
  const localNames = new Set(refs.filter((ref) => ref.kind === 'branch').map((ref) => ref.name));
  for (const ref of refs) {
    const remote = ref.kind === 'remote' ? remoteOf(ref) : null;
    if (remote && localNames.has(ref.name.slice(remote.length + 1))) continue;
    const paired = ref.kind === 'branch' ? refs.filter((r) => r.kind === 'remote' && r.name.slice((remoteOf(r) || '').length + 1) === ref.name) : [];
    const badge = element('span', 'history__ref');
    badge.dataset.kind = ref.kind;
    badge.dataset.current = String(ref.current);
    badge.style.setProperty('--ref-color', ref.kind === 'tag' ? 'var(--history-magenta, var(--color-accent))' : color);
    badge.title = [ref.name, ...paired.map((r) => r.name)].join(', ');
    if (ref.current) badge.append(refIcon('check'));
    if (ref.kind === 'tag') badge.append(refIcon('tag'));
    if (remote || paired.length) {
      const github = remote ? remotes[remote].github : paired.some((r) => remotes[remoteOf(r)]?.github);
      badge.append(refIcon(github ? 'github' : 'cloud'));
    }
    const name = document.createElement('span');
    name.className = 'history__ref-name';
    name.textContent = ref.name;
    badge.append(name);
    el.append(badge);
  }
  return el;
}

// 幅は行ごとに、その行で使う列だけにする（VS Code と同じく、件名が線の図のすぐ右から始まる）
function rowColumns(graph) {
  return 1 + Math.max(graph.node.column,
    ...graph.through.map((p) => p.column),
    ...[...graph.incoming, ...graph.outgoing].flatMap((p) => [p.from, p.to]));
}

function renderGraph(graph) {
  const columns = rowColumns(graph);
  const width = Math.min(8, columns) * 16;
  const svg = svgElement('svg', { class: 'history__graph', width, height: 22, viewBox: `0 0 ${width} 22`, 'aria-hidden': 'true', 'data-clipped': String(columns > 8) });
  function line(from, to, start, end, color, edge) {
    const x1 = from * 16 + 8;
    const x2 = to * 16 + 8;
    const middle = (start + end) / 2;
    const d = from === to ? `M${x1} ${start}V${end}` : `M${x1} ${start}C${x1} ${middle} ${x2} ${middle} ${x2} ${end}`;
    svg.append(svgElement('path', { d, stroke: graphColor(color), fill: 'none', 'stroke-width': 2, 'data-edge': edge, 'data-from': from, 'data-to': to }));
  }
  for (const path of graph.through) line(path.column, path.column, 0, 22, path.color, 'through');
  for (const path of graph.incoming) line(path.from, path.to, 0, 11, path.color, 'incoming');
  for (const path of graph.outgoing) line(path.from, path.to, 11, 22, path.color, 'outgoing');
  const node = graph.node;
  if (node.column < 8) {
    const x = node.column * 16 + 8;
    svg.append(svgElement('circle', { cx: x, cy: 11, r: node.merge ? 7 : 4, fill: node.merge ? 'var(--color-bg)' : graphColor(node.color), stroke: graphColor(node.color), 'stroke-width': 2, class: node.merge ? 'history__merge' : 'history__dot' }));
    if (node.merge) svg.append(svgElement('path', { d: `M${x - 3} 10l3 3 3-3`, fill: 'none', stroke: graphColor(node.color), 'stroke-width': 1.5 }));
  }
  return svg;
}

function renderRows() {
  const fragment = document.createDocumentFragment();
  const unpushed = new Set(state.unpushed);
  const top = state.top;
  const commits = state.rows.map((row) => row.commit);
  const hashes = new Set(commits.map((commit) => commit.hash));
  const filtered = Boolean(fileFilter || query.value.trim());
  const graph = buildHistoryGraph(filtered ? commits.map((commit) => ({ ...commit, parents: commit.parents.filter((hash) => hashes.has(hash)) })) : commits);
  commits.forEach((commit, index) => {
    const layout = graph.rows[index];
    // 絞り込みで親が省かれても、マージの印は元の親の数から決める
    layout.node.merge = commit.parents.length > 1;
    const row = element('button', 'history__row');
    row.type = 'button';
    row.dataset.hash = commit.hash;
    row.dataset.reachable = String(commit.reachable);
    row.dataset.column = layout.node.column;
    row.title = `${commit.hash}\n${commit.author}\n${commit.date}\n${commit.subject}`;
    const heading = element('span', 'history__subject');
    const prefix = commit.subject.match(/^[a-z]+(\([^)]*\))?!?:/);
    if (prefix) heading.append(element('strong', '', prefix[0]), document.createTextNode(commit.subject.slice(prefix[0].length)));
    else heading.textContent = commit.subject;
    row.append(renderGraph(layout), badges(commit.refs, graphColor(layout.node.color), state.remotes), heading);
    if (commit.hasBody) {
      const body = element('span', 'history__body-mark', '↩');
      body.title = '本文あり';
      body.setAttribute('aria-label', '本文あり');
      row.append(body);
    }
    if (unpushed.has(commit.hash)) {
      const arrow = element('span', 'history__unpushed', '↑');
      arrow.title = 'まだプッシュしていない';
      arrow.setAttribute('aria-label', 'まだプッシュしていない');
      row.append(arrow);
    }
    row.addEventListener('click', () => openCommit(top, commit.hash, commit.subject));
    fragment.append(row);
  });
  list.replaceChildren(fragment);
}

function action(label, fn) {
  const button = element('button', 'btn btn--xs', label);
  button.type = 'button';
  button.addEventListener('click', fn);
  return button;
}

// 詳細タブの寿命は app.js が管理し、閉じた後の読み出し結果は捨てる
export function renderCommitView(el, top, hash, { openCommit: open, onLoad }) {
  let disposed = false;
  const body = element('div', 'commit-view__body');
  body.tabIndex = 0;
  body.setAttribute('aria-label', 'コミットの詳細');
  el.append(body);
  async function load() {
    body.replaceChildren(element('p', 'diff__notice', 'コミットを読み込み中…'));
    let res;
    try { res = await terp.historyCommit({ dir: top, hash }); }
    catch (err) { res = { ok: false, error: err.message }; }
    if (disposed) return;
    if (!res.ok) {
      body.replaceChildren(element('p', 'diff__notice', `コミットを読めない: ${res.error}`), action('読み直す', load));
      return;
    }
    const info = res.value;
    onLoad(info);
    const head = element('header', 'commit-view__head');
    const title = element('h2', 'commit-view__title', info.subject);
    const copyStatus = element('span', 'commit-view__copy-status');
    copyStatus.setAttribute('role', 'status');
    const copy = action(info.shortHash, async () => {
      try {
        await navigator.clipboard.writeText(info.hash);
        if (!disposed) copyStatus.textContent = 'コピーした';
      } catch (err) {
        if (!disposed) copyStatus.textContent = `コピーできない: ${err.message}`;
      }
    });
    copy.title = `${info.hash} をコピー`;
    const author = element('div', 'commit-view__meta', `作者: ${info.author} · ${info.date}`);
    const committer = element('div', 'commit-view__meta', `コミッター: ${info.committer} · ${info.commitDate}`);
    const parents = element('div', 'commit-view__parents', '親: ');
    for (const parent of info.parents) {
      const button = action(parent.slice(0, 7), () => open(top, parent));
      button.dataset.parent = parent;
      button.title = parent;
      parents.append(button);
    }
    if (!info.parents.length) parents.append('なし');
    head.append(title, copy, copyStatus, author, committer, parents, badges(info.refs));
    const message = element('pre', 'commit-view__message', info.message);
    const files = element('div', 'commit-view__files');
    for (const file of info.files) {
      const section = element('section', 'commit-view__file');
      const toggle = action('', toggleDiff);
      toggle.className = 'commit-view__file-toggle';
      toggle.dataset.file = file.path;
      toggle.setAttribute('aria-expanded', 'false');
      const code = element('span', 'git__code', file.code);
      code.dataset.code = file.code;
      const name = file.from ? `${file.from} → ${file.path}` : file.path;
      toggle.append(code, element('span', '', name));
      toggle.title = name;
      const diff = element('div', 'commit-view__diff');
      diff.hidden = true;
      let version = 0;
      async function toggleDiff() {
        const token = ++version;
        diff.hidden = !diff.hidden;
        toggle.setAttribute('aria-expanded', String(!diff.hidden));
        if (diff.hidden) return;
        diff.replaceChildren(element('p', 'diff__notice', '差分を読み込み中…'));
        let result;
        try { result = await terp.historyDiff({ dir: top, hash: info.hash, file: file.path }); }
        catch (err) { result = { ok: false, error: err.message }; }
        if (disposed || token !== version) return;
        if (!result.ok) {
          diff.replaceChildren(element('p', 'diff__notice', `差分を読めない: ${result.error}`), action('読み直す', () => { diff.hidden = true; toggleDiff(); }));
          return;
        }
        const value = result.value;
        diff.replaceChildren(value.binary ? element('p', 'diff__notice', 'バイナリのファイル') : value.text ? renderDiff(value.text) : element('p', 'diff__notice', '差分はない'));
        if (value.truncated) diff.append(element('p', 'diff__notice', '差分が長いため、5,000 行で打ち切った'));
      }
      section.append(toggle, diff);
      files.append(section);
    }
    if (!info.files.length) files.append(element('p', 'diff__notice', '変わったファイルはない'));
    body.replaceChildren(head, message, element('h3', 'commit-view__files-title', `変わったファイル ${info.files.length}`), files);
  }
  const ready = load();
  return { ready, dispose: () => { disposed = true; } };
}
