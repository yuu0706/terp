// 右の面の「変更」と差分の表示。対象は、表示中のタブの作業場所を含む worktree。
// 右の面の開け閉めと切り替えは app.js が受け持ち、ここは setGitVisible で見えているかだけを受け取る
const terp = window.terp;

const panel = document.getElementById('git-view');
const toggleCounts = [document.getElementById('git-toggle-count'), document.getElementById('panel-tab-git-count')];
const emptyEl = document.getElementById('git-empty');
const content = document.getElementById('git-content');
const branchEl = document.getElementById('git-branch');
const abEl = document.getElementById('git-ab');
const upstreamEl = document.getElementById('git-upstream');
const identityEl = document.getElementById('git-identity');
const commitForm = document.getElementById('git-commit');
const commitReason = document.getElementById('git-commit-reason');
const resultEl = document.getElementById('git-result');
const diffView = document.getElementById('diff-view');
const diffTitle = document.getElementById('diff-title');
const diffKind = document.getElementById('diff-kind');
const diffBody = document.getElementById('diff-body');

const KIND_LABELS = { staged: 'ステージ済み', unstaged: '未ステージ', untracked: '追跡外', conflicted: '競合' };
const PLUS_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
const MINUS_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>';

let getCwd = () => null;
let state = null;
let lastJson = '';
let busy = false;
// 開いている差分。読み直しても同じファイルを出し続ける
let openDiff = null;
let visible = false;

export function initGitPanel({ activeCwd }) {
  getCwd = activeCwd;
  document.getElementById('git-fetch').addEventListener('click', () => runSync('fetch'));
  document.getElementById('git-pull').addEventListener('click', () => runSync('pull'));
  document.getElementById('git-push').addEventListener('click', () => runSync('push'));
  document.getElementById('diff-close').addEventListener('click', closeDiff);
  for (const action of ['stage-all', 'unstage-all']) {
    panel.querySelector(`[data-action="${action}"]`).addEventListener('click', () => {
      if (!state) return;
      const files = (action === 'stage-all' ? state.unstaged : state.staged).map((f) => f.path);
      if (files.length) runFileAction(action === 'stage-all' ? 'stage' : 'unstage', files);
    });
  }
  commitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    commit();
  });
  commitForm.elements.message.addEventListener('input', updateCommitButton);
  commitForm.elements.message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      commit();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !diffView.hidden) closeDiff();
  });
  setInterval(() => refresh(false), 3000);
}

export function setGitVisible(open) {
  visible = open;
  panel.hidden = !open;
  if (!open) closeDiff();
  refresh(true);
}

function showResult(text, tone = '') {
  resultEl.textContent = text.trim();
  resultEl.dataset.tone = tone;
  resultEl.hidden = !text.trim();
}

// 表示中のターミナルが変わったとき・定期的に呼ぶ。force なら変わっていなくても描き直す
export async function refresh(force) {
  const cwd = getCwd();
  const res = cwd ? await terp.gitStatus(cwd) : { ok: true, value: null };
  const next = res.ok ? res.value : null;
  const count = next ? next.staged.length + next.unstaged.length + next.conflicted.length : 0;
  for (const el of toggleCounts) {
    el.textContent = String(count);
    el.hidden = count === 0;
  }
  const json = JSON.stringify(res);
  if (!force && json === lastJson) return;
  lastJson = json;
  state = next;
  if (!visible) return;
  render(res);
}

function render(res) {
  if (!res.ok || !state) {
    content.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = res.ok ? 'このターミナルの場所は git のリポジトリではありません' : `git の状態を読めません: ${res.error}`;
    closeDiff();
    return;
  }
  emptyEl.hidden = true;
  content.hidden = false;
  branchEl.textContent = state.branch === '(detached)' ? `（ブランチなし）${state.oid.slice(0, 7)}` : state.branch;
  branchEl.title = state.top;
  abEl.textContent = state.upstream ? `↑${state.ahead} ↓${state.behind}` : '';
  abEl.title = state.upstream ? `${state.upstream} より ${state.ahead} 件進み、${state.behind} 件遅れ` : '';
  upstreamEl.textContent = state.upstream ? `追跡先: ${state.upstream}` : '追跡先がありません。プッシュすると origin に同じ名前で作ります';
  const { name, email } = state.identity;
  identityEl.textContent = name || email ? `コミットの名義: ${name} <${email}>` : 'コミットの名義が設定されていません（git config user.name / user.email）';
  renderGroup('conflicted', state.conflicted);
  renderGroup('staged', state.staged);
  renderGroup('unstaged', state.unstaged);
  const clean = state.staged.length + state.unstaged.length + state.conflicted.length === 0;
  document.getElementById('git-clean').hidden = !clean;
  for (const group of ['staged', 'unstaged']) panel.querySelector(`[data-group="${group}"]`).hidden = clean;
  syncLabels();
  updateCommitButton();
  // 開いている差分のファイルが一覧から消えたら閉じ、残っていれば読み直す
  if (openDiff) {
    const still = state[openDiff.group]?.some((f) => f.path === openDiff.path);
    if (still) showDiff(openDiff.path, openDiff.group, openDiff.code, false);
    else closeDiff();
  }
}

function renderGroup(group, files) {
  const section = panel.querySelector(`[data-group="${group}"]`);
  section.querySelector('.git__count').textContent = String(files.length);
  if (group === 'conflicted') section.hidden = files.length === 0;
  const button = section.querySelector('[data-action]');
  if (button) button.disabled = files.length === 0;
  const list = section.querySelector('.git__files');
  list.textContent = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'git__file';
    li.title = f.from ? `${f.from} → ${f.path}` : f.path;
    li.setAttribute('aria-current', String(openDiff?.path === f.path && openDiff?.group === group));
    const code = document.createElement('span');
    code.className = 'git__code';
    code.dataset.code = f.code;
    code.textContent = f.code;
    const name = document.createElement('span');
    name.className = 'git__path';
    // 長いパスは先頭を省き、ファイル名が見えるようにする（direction: rtl）。記号が崩れないよう前後に印を置く
    name.textContent = `‎${f.path}‎`;
    li.append(code, name);
    if (group !== 'conflicted') {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.type = 'button';
      const staging = group === 'unstaged';
      btn.innerHTML = staging ? PLUS_ICON : MINUS_ICON;
      btn.setAttribute('aria-label', `${f.path} を${staging ? 'ステージ' : 'ステージから外す'}`);
      btn.title = staging ? 'ステージ' : 'ステージから外す';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runFileAction(staging ? 'stage' : 'unstage', [f.path]);
      });
      li.append(btn);
    }
    li.addEventListener('click', () => showDiff(f.path, group, f.code, true));
    list.append(li);
  }
}

function updateCommitButton() {
  const button = commitForm.querySelector('[type="submit"]');
  const message = commitForm.elements.message.value.trim();
  let reason = '';
  if (!state || state.staged.length === 0) reason = 'ステージ済みのファイルがありません';
  else if (state.conflicted.length > 0) reason = '競合を解決してからコミットしてください';
  else if (!message) reason = 'コミットメッセージを入れてください';
  button.disabled = Boolean(reason) || busy;
  commitReason.textContent = reason;
  commitReason.hidden = !reason;
}

async function runFileAction(action, files) {
  if (!state || busy) return;
  const res = await (action === 'stage' ? terp.gitStage : terp.gitUnstage)({ top: state.top, files });
  if (!res.ok) showResult(res.error, 'error');
  await refresh(true);
}

// AI でコミットメッセージを書く（設定の「AI の手伝い」で切れる）。ステージした差分だけを渡す
const aiButton = document.getElementById('git-ai-message');
export function setGitAi(enabled) {
  aiButton.hidden = !enabled;
}
aiButton.addEventListener('click', async () => {
  if (aiButton.disabled || !state?.top) return;
  aiButton.disabled = true;
  aiButton.textContent = '考え中…';
  const res = await terp.aiCommitMessage(state.top);
  aiButton.disabled = false;
  aiButton.textContent = 'AI で書く';
  if (!res.ok) { showResult(res.error, 'error'); return; }
  const message = commitForm.elements.message;
  message.value = res.value;
  message.focus();
  updateCommitButton();
});

async function commit() {
  updateCommitButton();
  const button = commitForm.querySelector('[type="submit"]');
  if (button.disabled) return;
  busy = true;
  button.disabled = true;
  const res = await terp.gitCommit({ top: state.top, message: commitForm.elements.message.value.trim() });
  busy = false;
  if (res.ok) {
    commitForm.elements.message.value = '';
    showResult(res.value);
  } else {
    showResult(res.error, 'error');
  }
  await refresh(true);
}

// Push と Pull のボタンに、送る件数と取り込む件数を添える。ボタンの名前は git のコマンドと同じ英語にする（2026-10-29 利用者の指示）
function syncLabels() {
  if (busy || !state) return;
  document.getElementById('git-fetch').textContent = 'Fetch';
  document.getElementById('git-pull').textContent = state.behind ? `Pull ↓${state.behind}` : 'Pull';
  document.getElementById('git-push').textContent = state.ahead ? `Push ↑${state.ahead}` : 'Push';
}

const SYNC = {
  fetch: { run: (top) => terp.gitFetch(top), label: 'Fetch' },
  pull: { run: (top) => terp.gitPull(top), label: 'Pull' },
  push: { run: (top) => terp.gitPush(top), label: 'Push' },
};

async function runSync(kind) {
  if (!state || busy) return;
  const button = document.getElementById(`git-${kind}`);
  busy = true;
  for (const k of Object.keys(SYNC)) document.getElementById(`git-${k}`).disabled = true;
  button.textContent = `${SYNC[kind].label} 中…`;
  const res = await SYNC[kind].run(state.top);
  busy = false;
  for (const k of Object.keys(SYNC)) document.getElementById(`git-${k}`).disabled = false;
  button.textContent = SYNC[kind].label;
  syncLabels();
  // git は進み具合を標準エラーに出すため、成功でも出力があれば見せる
  if (res.ok) showResult(res.value || `${SYNC[kind].label} しました`);
  else showResult(res.error, 'error');
  await refresh(true);
}

// ---- 差分 ----

function closeDiff() {
  if (diffView.hidden && !openDiff) return;
  diffView.hidden = true;
  openDiff = null;
  for (const li of panel.querySelectorAll('.git__file[aria-current="true"]')) li.setAttribute('aria-current', 'false');
}

async function showDiff(file, group, code, focus) {
  if (!state) return;
  const kind = group === 'unstaged' && code === '?' ? 'untracked' : group === 'conflicted' ? 'unstaged' : group;
  openDiff = { path: file, group, code };
  for (const li of panel.querySelectorAll('.git__file')) {
    li.setAttribute('aria-current', String(li.title.endsWith(file) && li.closest(`[data-group="${group}"]`) !== null));
  }
  diffTitle.textContent = file;
  diffKind.textContent = KIND_LABELS[kind];
  const res = await terp.gitDiff({ top: state.top, file, kind });
  diffView.hidden = false;
  diffBody.textContent = '';
  if (!res.ok) {
    diffBody.append(notice(`差分を読めません: ${res.error}`));
    return;
  }
  if (res.value.binary) diffBody.append(notice('バイナリのファイルのため、差分を表示しません'));
  else if (!res.value.text.trim()) diffBody.append(notice('差分はありません'));
  else diffBody.append(renderDiff(res.value.text));
  if (res.value.truncated) diffBody.append(notice('差分が長いため、5,000 行で打ち切りました'));
  if (focus) diffBody.scrollTop = 0;
}

function notice(text) {
  const p = document.createElement('p');
  p.className = 'diff__notice';
  p.textContent = text;
  return p;
}

// unified diff を、古い行番号・新しい行番号・本文の3列の表にする
export function renderDiff(text) {
  const table = document.createElement('table');
  table.className = 'diff__table';
  const body = document.createElement('tbody');
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      body.append(row('diff__row--hunk', '', '', line));
      continue;
    }
    // 見出しの行（diff --git・index・---・+++）は表に出さない
    if (!inHunk) continue;
    if (line.startsWith('+')) body.append(row('diff__row--add', '', newNo++, line));
    else if (line.startsWith('-')) body.append(row('diff__row--del', oldNo++, '', line));
    else if (line.startsWith('\\')) body.append(row('', '', '', line));
    else body.append(row('', oldNo++, newNo++, line));
  }
  table.append(body);
  return table;
}

function row(cls, oldNo, newNo, text) {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  for (const [value, c] of [
    [oldNo, 'diff__num'],
    [newNo, 'diff__num'],
    [text, 'diff__text'],
  ]) {
    const td = document.createElement('td');
    td.className = c;
    td.textContent = String(value);
    tr.append(td);
  }
  return tr;
}
