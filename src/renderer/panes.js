// 枠の木は DOM と切り離し、控えの復元と画面の操作で同じ処理を使う。
import { isPathDrop } from './droppaths.js';

export const MAX_PANES = 6;
export const MIN_PANE_SIZE = 120;
export const TAB_DRAG_TYPE = 'text/x-terp-tab';

// 帯の文字は DOM と切り離し、名前の優先順は呼び出し側の displayName に任せる。
export function paneTitle({ kind, name = '', program = '', cwd = '', home = '', work = null, path = '', dirty = false }) {
  const short = (value) => home && (value === home || value.startsWith(home + '/')) ? '~' + value.slice(home.length) : value;
  if (kind === 'terminal') {
    const place = work ? `${work.repo.split('/').pop()} / ${work.branch || `（ブランチなし）${work.head}`}` : short(cwd);
    return { name, detail: [program, place].filter(Boolean).join(' · '), title: [name, program, cwd].filter(Boolean).join('\n') };
  }
  if (kind === 'file') {
    const relative = work && path.startsWith(work.path + '/') ? path.slice(work.path.length + 1) : short(path);
    return { name: name + (dirty ? ' ●' : ''), detail: relative, title: [name + (dirty ? ' ●' : ''), path].filter(Boolean).join('\n') };
  }
  return { name, detail: '', title: name };
}

export function paneList(tree) {
  return !tree ? [] : tree.type === 'pane' ? [tree] : tree.children.flatMap(paneList);
}

// 枠は、出しているタブ（key）と、その枠のタブの並び（tabs）と、前に出していた順（history）を持つ。
// 1つのタブは1つの枠のタブにだけ入る（VS Code のエディタのグループと同じ。2026-11-17 利用者の指示で上の全体のタブをやめた）
export function createPane(key = null, id = 'pane-1') {
  return { type: 'pane', id, key, tabs: key ? [key] : [], history: [] };
}

function mapPane(tree, id, change) {
  if (tree.type === 'pane') return tree.id === id ? change(tree) : tree;
  return { ...tree, children: tree.children.map((child) => mapPane(child, id, change)) };
}

function normalize(sizes) {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (Number.isFinite(sum)) return sizes.map((n) => n / sum);
  const scale = Math.max(...sizes);
  return normalize(sizes.map((n) => n / scale));
}

export function closePane(tree, id) {
  const remove = (node) => {
    if (node.type === 'pane') return node.id === id ? null : node;
    const kept = node.children.map((child, i) => ({ node: remove(child), size: node.sizes[i] })).filter((c) => c.node);
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0].node;
    return { ...node, children: kept.map((c) => c.node), sizes: normalize(kept.map((c) => c.size)) };
  };
  return remove(tree) || createPane(null, tree.id || id);
}

// 固定した枠（VS Code のグループのロック）は、タブを切り替えても中身を差し替えない
export function setPaneLocked(tree, id, locked) {
  return mapPane(tree, id, (pane) => {
    const { locked: _drop, ...rest } = pane;
    return locked ? { ...rest, locked: true } : rest;
  });
}

// タブを開く枠を選ぶ。今の枠が固定なら、固定していない枠のうち並びの先のもの。全部固定なら null
export function openPaneFor(tree, activeId) {
  const list = paneList(tree);
  const active = list.find((p) => p.id === activeId);
  if (active && !active.locked) return active.id;
  return list.find((p) => !p.locked)?.id ?? null;
}

// 枠ごとに、前に出していたタブを新しい順に覚える。閉じたときに、その枠へ戻す先にする
export const PANE_HISTORY = 20;

// 枠の中で、出しているタブを外したときに次に出すタブ。前に出していた順を先に見て、無ければ並びの隣
export function nextPaneKey(pane, removed = pane.key) {
  const tabs = (pane.tabs || []).filter((k) => k !== removed);
  const fromHistory = (pane.history || []).find((k) => k !== removed && tabs.includes(k));
  if (fromHistory) return fromHistory;
  const at = (pane.tabs || []).indexOf(removed);
  return tabs[Math.max(0, Math.min(at - 1, tabs.length - 1))] ?? null;
}

// ほかの枠のタブから key を外す。その枠が key を出していたら次のタブに替え、タブが無くなった枠は畳む
function takeKey(tree, key, keepId) {
  const emptied = [];
  const next = mapPanes(tree, (pane) => {
    if (pane.id === keepId || !(pane.tabs || []).includes(key)) return pane;
    const rest = { ...pane, tabs: pane.tabs.filter((k) => k !== key), history: (pane.history || []).filter((k) => k !== key) };
    if (pane.key !== key) return rest;
    const replacement = nextPaneKey(pane, key);
    if (!replacement) emptied.push(pane.id);
    return { ...rest, key: replacement };
  });
  return emptied.reduce((t, id) => closePane(t, id), next);
}

function mapPanes(tree, change) {
  if (tree.type === 'pane') return change(tree);
  return { ...tree, children: tree.children.map((child) => mapPanes(child, change)) };
}

export function replacePane(tree, id, key) {
  if (!paneList(tree).some((p) => p.id === id)) return tree;
  const next = mapPane(tree, id, (pane) => {
    const tabs = [...(pane.tabs || [])];
    if (key && !tabs.includes(key)) {
      const at = tabs.indexOf(pane.key);
      tabs.splice(at < 0 ? tabs.length : at + 1, 0, key);
    }
    if (pane.key === key) return { ...pane, tabs };
    const history = [pane.key, ...(pane.history || [])].filter((k, i, all) => k && k !== key && all.indexOf(k) === i && tabs.includes(k)).slice(0, PANE_HISTORY);
    return { ...pane, key, tabs, history };
  });
  return key ? takeKey(next, key, id) : next;
}

// 閉じたタブは、どの枠のタブと履歴からも外す。出している枠の差し替えは呼び出し側が先に済ませる
export function forgetPaneKey(tree, key) {
  return mapPanes(tree, (pane) => (pane.tabs || []).includes(key) || (pane.history || []).includes(key)
    ? { ...pane, tabs: (pane.tabs || []).filter((k) => k !== key), history: (pane.history || []).filter((k) => k !== key) }
    : pane);
}

// 枠の × で閉じるとき、その枠のタブのうち keep が真のものを、残る枠（into）のタブの後ろへ移す
export function closePaneMoving(tree, id, into, keep) {
  const pane = paneList(tree).find((p) => p.id === id);
  const moved = (pane?.tabs || []).filter(keep);
  const next = closePane(tree, id);
  if (!moved.length || !paneList(next).some((p) => p.id === into)) return next;
  return mapPane(next, into, (target) => ({ ...target, tabs: [...(target.tabs || []), ...moved.filter((k) => !(target.tabs || []).includes(k))] }));
}

// 枠のタブに入っていないタブを、指定の枠のタブの後ろへ足す
export function adoptKeys(tree, id, keys) {
  const owned = new Set(paneList(tree).flatMap((p) => p.tabs || []));
  const orphans = keys.filter((k) => !owned.has(k));
  if (!orphans.length) return tree;
  return mapPane(tree, id, (pane) => ({ ...pane, tabs: [...(pane.tabs || []), ...orphans] }));
}

export function splitPane(tree, id, key, side = 'right') {
  if (!['left', 'right', 'top', 'bottom'].includes(side) || paneList(tree).length >= MAX_PANES) return replacePane(tree, id, key);
  const target = paneList(tree).find((p) => p.id === id);
  if (!target || target.key === key) return tree;
  const ids = new Set(paneList(tree).map((p) => p.id));
  let serial = 1;
  while (ids.has(`pane-${serial}`)) serial++;
  const added = createPane(key, `pane-${serial}`);
  const next = mapPane(tree, id, (pane) => ({
    type: 'split', dir: ['left', 'right'].includes(side) ? 'row' : 'column',
    children: ['left', 'top'].includes(side) ? [added, pane] : [pane, added], sizes: [0.5, 0.5],
  }));
  return takeKey(next, key, added.id);
}

export function resizeSplit(tree, path, index, delta, extent, minimums = []) {
  if (path.length) {
    if (tree.type !== 'split' || !tree.children[path[0]]) return tree;
    return { ...tree, children: tree.children.map((child, i) => i === path[0] ? resizeSplit(child, path.slice(1), index, delta, extent, minimums) : child) };
  }
  if (tree.type !== 'split' || !tree.sizes[index + 1] || extent <= 0) return tree;
  const sizes = [...tree.sizes];
  const pair = sizes[index] + sizes[index + 1];
  const low = (minimums[index] || MIN_PANE_SIZE) / extent;
  const high = pair - (minimums[index + 1] || MIN_PANE_SIZE) / extent;
  if (low > high) return tree;
  sizes[index] = Math.max(low, Math.min(high, sizes[index] + delta / extent));
  sizes[index + 1] = pair - sizes[index];
  return { ...tree, sizes };
}

// 壊れた控え・重複・消えたタブはここで落とし、1つの子だけ残った分割は畳む。
export function restoreLayout(value, keys, { transient = false } = {}) {
  const allowed = new Set(keys);
  const seen = new Set();
  const ids = new Set();
  let count = 0;
  const read = (node, depth = 0) => {
    if (!node || depth > 20 || count >= MAX_PANES) return null;
    if (node.type === 'pane') {
      const usable = (k) => typeof k === 'string' && (transient || !k.startsWith('s:')) && allowed.has(k) && !seen.has(k);
      const tabs = [...new Set([...(Array.isArray(node.tabs) ? node.tabs : []), node.key])].filter(usable);
      const history = (Array.isArray(node.history) ? node.history : []).filter((k) => tabs.includes(k) && k !== node.key);
      const key = tabs.includes(node.key) ? node.key : history[0] || tabs[0];
      if (!key) return null;
      for (const k of tabs) seen.add(k);
      count++;
      let id = typeof node.id === 'string' && node.id ? node.id : `pane-${count}`;
      while (ids.has(id)) id += '-restored';
      ids.add(id);
      const pane = { ...createPane(key, id), tabs, history: history.filter((k) => k !== key).slice(0, PANE_HISTORY) };
      return node.locked === true ? { ...pane, locked: true } : pane;
    }
    if (node.type !== 'split' || !['row', 'column'].includes(node.dir) || !Array.isArray(node.children)) return null;
    const kept = node.children.slice(0, MAX_PANES).map((child, i) => ({ node: read(child, depth + 1), size: node.sizes?.[i] })).filter((c) => c.node);
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0].node;
    return { type: 'split', dir: node.dir, children: kept.map((c) => c.node), sizes: normalize(kept.map((c) => Number.isFinite(c.size) && c.size > 0 ? c.size : 1)) };
  };
  return read(value) || createPane();
}

export function dropSide(rect, x, y) {
  const distances = [['left', (x - rect.left) / rect.width], ['right', (rect.right - x) / rect.width], ['top', (y - rect.top) / rect.height], ['bottom', (rect.bottom - y) / rect.height]];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][1] < 0.25 ? distances[0][0] : 'center';
}

export function makeTabDraggable(el, key) {
  el.draggable = true;
  el.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TAB_DRAG_TYPE, key);
  });
}

function minimumSize(tree, dir, gutter) {
  if (tree.type === 'pane') return MIN_PANE_SIZE;
  const values = tree.children.map((child) => minimumSize(child, dir, gutter));
  return tree.dir === dir ? values.reduce((a, b) => a + b, 0) + gutter * (values.length - 1) : Math.max(...values);
}

export function createPaneView(host, { onActivate, onClose, onDrop, onResize, canDropPaths, onDropPaths, onRename, onLock }) {
  let tree;
  let signature;
  const elements = new Map();
  const clearDrop = () => host.querySelectorAll('[data-drop], [data-drop-paths]').forEach((el) => {
    delete el.dataset.drop;
    delete el.dataset.dropPaths;
  });
  const shape = (node) => node.type === 'pane' ? node.id : [node.dir, ...node.children.map(shape)];
  const gutterSize = () => parseFloat(getComputedStyle(host).getPropertyValue('--space-1')) + 1;
  const setSizes = (node, el) => {
    if (node.type === 'pane') return;
    const children = [...el.children].filter((child) => !child.classList.contains('pane-gutter'));
    children.forEach((child, i) => {
      child.style.flex = `${node.sizes[i]} 1 0px`;
      child.style.minWidth = `${minimumSize(node.children[i], 'row', gutterSize())}px`;
      child.style.minHeight = `${minimumSize(node.children[i], 'column', gutterSize())}px`;
      setSizes(node.children[i], child);
    });
  };
  function build(node, path = []) {
    if (node.type === 'pane') {
      if (elements.has(node.id)) return elements.get(node.id);
      const el = document.createElement('section');
      el.className = 'pane';
      el.dataset.paneId = node.id;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'pane__close icon-btn';
      close.setAttribute('aria-label', '枠を閉じる');
      close.title = '枠を閉じる';
      close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';
      close.addEventListener('click', (e) => { e.stopPropagation(); onClose(node.id); });
      const lock = document.createElement('button');
      lock.type = 'button';
      lock.className = 'pane__lock icon-btn';
      lock.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path class="pane__lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>';
      lock.addEventListener('click', (e) => { e.stopPropagation(); onLock?.(node.id); });
      const title = document.createElement('header');
      title.className = 'pane__title';
      // 見出しは、その枠のタブの並び・出しているタブの補助の文字・新しいタブのボタンの置き場・錠・× の順
      title.innerHTML = '<div class="pane__tabs" role="tablist" aria-label="この枠のタブ"></div><span class="pane__detail"></span><div class="pane__actions"></div>';
      title.append(lock, close);
      title.addEventListener('dblclick', (event) => {
        if (!event.target.closest('button, input, .tab')) onRename?.(node.id);
      });
      const body = document.createElement('div');
      body.className = 'pane__body';
      el.append(title, body);
      el.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pane__close')) onActivate(node.id, false); }, true);
      el.addEventListener('focusin', () => onActivate(node.id, false));
      elements.set(node.id, el);
      return el;
    }
    const el = document.createElement('div');
    el.className = 'pane-split';
    el.dataset.dir = node.dir;
    node.children.forEach((child, i) => {
      if (i) {
        const gutter = document.createElement('div');
        gutter.className = 'pane-gutter';
        gutter.setAttribute('role', 'separator');
        gutter.setAttribute('aria-label', '枠の大きさを変更');
        gutter.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
        let drag;
        gutter.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const rect = el.getBoundingClientRect();
          const extent = (node.dir === 'row' ? rect.width : rect.height) - gutterSize() * (node.children.length - 1);
          drag = { start: node.dir === 'row' ? event.clientX : event.clientY, tree, extent, pointer: event.pointerId };
          // 自己診断の合成イベントには、捕まえられる実ポインタが無い。
          if (event.isTrusted) gutter.setPointerCapture(event.pointerId);
          host.dataset.resizing = node.dir;
        });
        gutter.addEventListener('pointermove', (event) => {
          if (!drag || drag.pointer !== event.pointerId) return;
          const delta = (node.dir === 'row' ? event.clientX : event.clientY) - drag.start;
          const mins = node.children.map((c) => minimumSize(c, node.dir, gutterSize()));
          onResize(resizeSplit(drag.tree, path, i - 1, delta, drag.extent, mins));
        });
        const finish = () => { drag = null; delete host.dataset.resizing; };
        gutter.addEventListener('pointerup', (event) => {
          if (gutter.hasPointerCapture(event.pointerId)) gutter.releasePointerCapture(event.pointerId);
          finish();
        });
        gutter.addEventListener('pointercancel', finish);
        gutter.addEventListener('lostpointercapture', finish);
        gutter.addEventListener('dblclick', () => {
          let split = tree;
          for (const part of path) split = split.children[part];
          const delta = (split.sizes[i] - split.sizes[i - 1]) / 2;
          // 比率を直接半分に戻す。ドラッグの最小寸法は resizeSplit で守る。
          onResize(resizeSplit(tree, path, i - 1, delta, 1, split.sizes.map(() => Number.EPSILON)));
        });
        el.append(gutter);
      }
      el.append(build(child, [...path, i]));
    });
    return el;
  }
  // Monaco がファイルを独自に開く前に、パスの入力として受け取る。
  for (const type of ['dragover', 'drop']) host.addEventListener(type, (event) => {
    if (!isPathDrop(event.dataTransfer, event.altKey)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrop();
    const pane = event.target.closest('.pane');
    const accepts = pane && host.contains(pane) && canDropPaths?.(pane.dataset.paneId);
    if (type === 'dragover') {
      event.dataTransfer.dropEffect = accepts ? 'copy' : 'none';
      if (accepts) pane.dataset.dropPaths = 'true';
    } else if (accepts) onDropPaths(event.dataTransfer, pane.dataset.paneId, event);
  }, true);
  host.addEventListener('dragover', (event) => {
    clearDrop();
    if (!event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
    const pane = event.target.closest('.pane');
    if (!pane || !host.contains(pane)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    pane.dataset.drop = paneList(tree).length >= MAX_PANES ? 'center' : dropSide(pane.getBoundingClientRect(), event.clientX, event.clientY);
  });
  host.addEventListener('drop', (event) => {
    const key = event.dataTransfer?.getData(TAB_DRAG_TYPE);
    const pane = event.target.closest('.pane');
    if (!key || !pane || !host.contains(pane)) return;
    event.preventDefault();
    const side = paneList(tree).length >= MAX_PANES ? 'center' : dropSide(pane.getBoundingClientRect(), event.clientX, event.clientY);
    clearDrop();
    onDrop(key, pane.dataset.paneId, side);
  });
  host.addEventListener('dragleave', (event) => { if (!host.contains(event.relatedTarget)) clearDrop(); });
  document.addEventListener('dragend', clearDrop);
  document.addEventListener('drop', clearDrop);
  return {
    render(next, activeId) {
      tree = next;
      const nextSignature = JSON.stringify(shape(tree));
      if (signature !== nextSignature) {
        host.replaceChildren(build(tree));
        signature = nextSignature;
      }
      const panes = paneList(tree);
      for (const [id, el] of elements) {
        if (!panes.some((p) => p.id === id)) { el.remove(); elements.delete(id); continue; }
        el.dataset.active = String(id === activeId);
        el.querySelector('.pane__close').hidden = panes.length === 1;
        const locked = Boolean(panes.find((p) => p.id === id)?.locked);
        const lock = el.querySelector('.pane__lock');
        el.dataset.locked = String(locked);
        lock.setAttribute('aria-pressed', String(locked));
        lock.title = locked ? '枠の固定を外す' : '枠を固定（タブを切り替えても中身を変えない）';
        lock.setAttribute('aria-label', locked ? '枠の固定を外す' : '枠を固定');
      }
      host.dataset.split = String(panes.length > 1);
      host.firstElementChild.style.minWidth = `${minimumSize(tree, 'row', gutterSize())}px`;
      host.firstElementChild.style.minHeight = `${minimumSize(tree, 'column', gutterSize())}px`;
      setSizes(tree, host.firstElementChild);
    },
    element: (id) => elements.get(id),
    body: (id) => elements.get(id)?.querySelector('.pane__body'),
  };
}
