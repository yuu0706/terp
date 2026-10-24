// 右の面の「ファイル」。表示中のタブの作業場所を含む worktree の一番上から、フォルダを木の形で出す。
// フォルダの中身は開いたときに読み、開いているフォルダだけを読み直す
import { makeTabDraggable } from './panes.js';

const terp = window.terp;

const view = document.getElementById('files-view');
const rootEl = document.getElementById('files-root');
const emptyEl = document.getElementById('files-empty');
const treeEl = document.getElementById('files-tree');

const CHEVRON = '<svg class="icon files__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>';
const FOLDER = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';
const FILE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>';

let getCwd = () => null;
let getActivePath = () => null;
let onOpenFile = () => {};
let visible = false;
let root = null;
// 開いているフォルダ。root ごとに覚え、root を切り替えて戻ったときに開き直す
const expandedByRoot = new Map();
// フォルダの中身の控え。開いているフォルダだけを読み直す
const children = new Map();
let rendering = false;

export function initFilesPanel({ activeCwd, activePath, openFile }) {
  getCwd = activeCwd;
  getActivePath = activePath;
  onOpenFile = openFile;
  // 外でファイルを足したり消したりしても拾えるよう、開いているフォルダを読み直す
  setInterval(() => refreshFiles(true), 5000);
}

export function setFilesVisible(open) {
  visible = open;
  view.hidden = !open;
  if (open) refreshFiles(true);
}

function expanded() {
  if (!expandedByRoot.has(root)) expandedByRoot.set(root, new Set([root]));
  return expandedByRoot.get(root);
}

// 表示中のタブが変わったとき・定期的に呼ぶ。force なら開いているフォルダを読み直す
export async function refreshFiles(force) {
  if (!visible || rendering) return;
  const cwd = getCwd();
  const res = cwd ? await terp.filesRoot(cwd) : { ok: true, value: null };
  const next = res.ok ? res.value : null;
  const rootChanged = next !== root;
  root = next;
  if (!root) {
    treeEl.textContent = '';
    rootEl.textContent = '';
    emptyEl.hidden = false;
    emptyEl.textContent = '表示中のタブの場所がわかりません';
    return;
  }
  emptyEl.hidden = true;
  rootEl.textContent = root.split('/').pop();
  rootEl.title = root;
  if (rootChanged || force) await load([...expanded()]);
  render();
}

async function load(dirs) {
  rendering = true;
  try {
    await Promise.all(
      dirs.map(async (dir) => {
        const res = await terp.listFiles(dir);
        if (res.ok) children.set(dir, res.value);
        // 消えたフォルダは閉じる
        else expanded().delete(dir);
      }),
    );
  } finally {
    rendering = false;
  }
}

function render() {
  const active = getActivePath();
  treeEl.textContent = '';
  const add = (dir, depth) => {
    for (const item of children.get(dir) || []) {
      const li = document.createElement('li');
      li.className = 'files__item';
      li.setAttribute('role', 'treeitem');
      li.style.setProperty('--depth', String(depth));
      li.tabIndex = -1;
      li.title = item.path.slice(root.length + 1);
      const open = item.dir && expanded().has(item.path);
      if (item.dir) li.setAttribute('aria-expanded', String(open));
      li.setAttribute('aria-current', String(item.path === active));
      li.innerHTML = `${item.dir ? CHEVRON : '<span class="files__spacer"></span>'}${item.dir ? FOLDER : FILE}<span class="files__name"></span>`;
      li.querySelector('.files__name').textContent = item.name;
      if (!item.dir) makeTabDraggable(li, `f:${item.path}`);
      li.addEventListener('click', () => (item.dir ? toggleDir(item.path) : onOpenFile(item.path)));
      treeEl.append(li);
      if (open) add(item.path, depth + 1);
    }
  };
  add(root, 0);
  if (!treeEl.children.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = 'ファイルはありません';
  }
}

async function toggleDir(dir) {
  if (expanded().has(dir)) expanded().delete(dir);
  else {
    expanded().add(dir);
    await load([dir]);
  }
  render();
}

// 開いたファイルの印だけを付け直す（中身は読み直さない）
export function markActiveFile() {
  if (visible && root) render();
}
