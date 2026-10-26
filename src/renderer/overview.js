export function filterOverview(items, query) {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => !needle || [item.name, item.repoName, item.repoPath, item.branch, item.cwd, item.workPath]
    .some((value) => String(value || '').toLowerCase().includes(needle)));
}

// 列数は窓幅とまとまりごとに変わるため、描画されたタイルの位置から隣を選ぶ。
export function overviewNeighbor(rects, id, direction) {
  const current = rects.find((rect) => rect.id === id);
  if (!current) return rects[0]?.id ?? null;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(direction)) return id;
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  const forward = direction === 'ArrowRight' || direction === 'ArrowDown';
  const center = (rect) => rect.left + rect.width / 2;
  const candidates = rects.filter((rect) => {
    if (rect.id === id) return false;
    if (horizontal) return Math.abs(rect.top - current.top) < 1 && (forward ? rect.left > current.left : rect.left < current.left);
    return forward ? rect.top > current.top + 1 : rect.top < current.top - 1;
  });
  candidates.sort((a, b) => horizontal
    ? Math.abs(a.left - current.left) - Math.abs(b.left - current.left)
    : Math.abs(a.top - current.top) - Math.abs(b.top - current.top)
      || Math.abs(center(a) - center(current)) - Math.abs(center(b) - center(current)) || a.left - b.left);
  return candidates[0]?.id ?? id;
}

export function createOverview({ host, snapshot, preview, renderStatus, star, activate, restoreFocus, beforeOpen }) {
  const button = document.createElement('button');
  button.id = 'overview-open';
  button.className = 'btn overview-open';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="6" /><rect x="14" y="4" width="7" height="6" /><rect x="3" y="14" width="7" height="6" /><rect x="14" y="14" width="7" height="6" /></svg><span>一覧</span><kbd class="btn__key">⌘M</kbd>';
  host.append(button);

  const dialog = document.createElement('dialog');
  dialog.id = 'overview';
  dialog.className = 'overview';
  dialog.setAttribute('aria-labelledby', 'overview-title');
  dialog.innerHTML = `<header class="overview__head">
    <h1 id="overview-title">全体の一覧</h1>
    <button class="btn" type="button" data-close>閉じる <kbd>Esc</kbd></button>
  </header>
  <div class="overview__search">
    <label for="overview-query">絞り込み</label>
    <input id="overview-query" class="input" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="overview-list" aria-expanded="false" />
    <span class="overview__hint">↑↓←→ で選ぶ · Enter で移る</span>
  </div>
  <div id="overview-list" class="overview__list" role="listbox" aria-label="全ターミナル"></div>
  <p class="overview__empty" role="status" hidden></p>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('.overview__list');
  const empty = dialog.querySelector('.overview__empty');
  let selected = null;
  let timer = null;
  let origin = null;
  let signature = null;
  const tiles = new Map();

  function select(id, scroll = false) {
    selected = id;
    for (const [key, tile] of tiles) tile.setAttribute('aria-selected', String(key === selected));
    const tile = tiles.get(selected);
    if (tile) input.setAttribute('aria-activedescendant', tile.id);
    else input.removeAttribute('aria-activedescendant');
    if (scroll) tile?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function render() {
    if (!dialog.open) return;
    const { workspaces, items } = snapshot();
    const matches = filterOverview(items, input.value);
    if (!matches.some((item) => item.id === selected)) selected = matches[0]?.id ?? null;
    const nextSignature = JSON.stringify([workspaces, matches.map((item) => [item.id, item.workspace, item.repoPath, item.repoName])]);
    if (signature !== nextSignature) {
      const tileHadFocus = document.activeElement?.closest('.overview__tile');
      signature = nextSignature;
      const fragment = document.createDocumentFragment();
      const keep = new Set();
      for (const workspace of workspaces) {
        const members = matches.filter((item) => item.workspace === workspace.id);
        if (!members.length) continue;
        const section = document.createElement('section');
        section.className = 'overview__workspace';
        section.dataset.workspace = workspace.id;
        section.setAttribute('role', 'group');
        section.setAttribute('aria-label', workspace.name);
        const heading = document.createElement('h2');
        heading.textContent = workspace.name;
        section.append(heading);
        for (const repoPath of new Set(members.map((item) => item.repoPath))) {
          const group = document.createElement('div');
          group.className = 'overview__repo';
          group.dataset.repo = repoPath || '';
          const repoHeading = document.createElement('h3');
          repoHeading.textContent = members.find((item) => item.repoPath === repoPath).repoName || 'その他のターミナル';
          const grid = document.createElement('div');
          grid.className = 'overview__grid';
          for (const item of members.filter((item) => item.repoPath === repoPath)) {
            let tile = tiles.get(item.id);
            if (!tile) {
              tile = document.createElement('button');
              tile.type = 'button';
              tile.className = 'overview__tile';
              tile.id = `overview-terminal-${item.id}`;
              tile.dataset.id = item.id;
              tile.tabIndex = -1;
              tile.setAttribute('role', 'option');
              tile.innerHTML = '<span class="overview__tile-head"><span class="session__dot"></span><span class="overview__name"></span><span class="overview__star" aria-label="お気に入り"></span></span><span class="overview__preview" aria-hidden="true"></span>';
              tile.querySelector('.overview__star').innerHTML = star;
              tiles.set(item.id, tile);
            }
            keep.add(item.id);
            grid.append(tile);
          }
          group.append(repoHeading, grid);
          section.append(group);
        }
        fragment.append(section);
      }
      for (const id of tiles.keys()) if (!keep.has(id)) tiles.delete(id);
      list.replaceChildren(fragment);
      if (tileHadFocus) (tiles.get(selected) || input).focus({ preventScroll: true });
    }
    for (const item of matches) {
      const tile = tiles.get(item.id);
      tile.querySelector('.overview__name').textContent = item.name;
      tile.querySelector('.overview__star').hidden = !item.favorite;
      tile.querySelector('.overview__preview').textContent = preview(item.id);
      tile.setAttribute('aria-current', String(item.current));
      tile.title = [item.name, item.branch, item.cwd].filter(Boolean).join('\n');
      renderStatus(tile, item);
    }
    select(selected);
    empty.hidden = matches.length > 0;
    empty.textContent = items.length ? '合うターミナルはない' : 'ターミナルはない';
  }

  function close(restore = true) {
    if (!dialog.open) return;
    dialog.close();
    clearInterval(timer);
    timer = null;
    button.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-expanded', 'false');
    if (restore) {
      if (origin?.isConnected && origin !== document.body) origin.focus({ preventScroll: true });
      else restoreFocus();
    }
  }

  function toggle() {
    if (dialog.open) { close(); return; }
    beforeOpen();
    origin = document.activeElement;
    selected = snapshot().activeId;
    input.value = '';
    signature = null;
    dialog.showModal();
    button.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-expanded', 'true');
    render();
    list.scrollTop = 0;
    select(selected, true);
    input.focus();
    timer = setInterval(render, 500);
  }

  function choose(id) {
    if (id === null) return;
    close(false);
    activate(id);
  }

  button.addEventListener('click', toggle);
  input.addEventListener('input', render);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    const tile = event.target.closest('.overview__tile');
    if (tile) { choose(Number(tile.dataset.id)); return; }
    if (!event.target.closest('input, label, button')) close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      event.stopPropagation();
      const rects = [...tiles].map(([id, tile]) => {
        const { left, top, width, height } = tile.getBoundingClientRect();
        return { id, left, top, width, height };
      });
      select(overviewNeighbor(rects, selected, event.key), true);
    } else if (event.key === 'Enter' && !event.target.closest('[data-close]')) {
      event.preventDefault();
      choose(selected);
    }
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => close());
  return { toggle, close, selectAll: () => { input.focus(); input.select(); }, get open() { return dialog.open; } };
}
