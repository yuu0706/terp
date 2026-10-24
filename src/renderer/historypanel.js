// 右の履歴の一覧と、作業画面に開くコミットの詳細
import { renderDiff } from './gitpanel.js';
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

function relativeDate(date) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return date;
  if (minutes < 1) return 'いま';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}時間前`;
  return `${Math.floor(minutes / 1440)}日前`;
}

function element(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function badges(refs) {
  const el = element('span', 'history__refs');
  for (const ref of refs.split(', ').filter(Boolean)) el.append(element('span', 'work__tag', ref));
  return el;
}

function renderRows() {
  const fragment = document.createDocumentFragment();
  const unpushed = new Set(state.unpushed);
  const top = state.top;
  for (const { graph, commit } of state.rows) {
    if (!commit) {
      const line = element('div', 'history__line');
      line.append(element('span', 'history__graph', graph));
      line.setAttribute('aria-hidden', 'true');
      fragment.append(line);
      continue;
    }
    const row = element('button', 'history__row');
    row.type = 'button';
    row.dataset.hash = commit.hash;
    row.title = `${commit.hash}\n${commit.author}\n${commit.date}\n${commit.subject}`;
    const body = element('span', 'history__summary');
    const heading = element('span', 'history__subject', commit.subject);
    const meta = element('span', 'history__meta');
    meta.append(element('span', 'history__author', commit.author), element('time', '', relativeDate(commit.date)));
    if (unpushed.has(commit.hash)) {
      const arrow = element('span', 'history__unpushed', '↑');
      arrow.title = 'まだプッシュしていない';
      arrow.setAttribute('aria-label', 'まだプッシュしていない');
      meta.append(arrow);
    }
    body.append(heading, badges(commit.refs), meta);
    row.append(element('span', 'history__graph', graph), body);
    row.addEventListener('click', () => openCommit(top, commit.hash, commit.subject));
    fragment.append(row);
  }
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
