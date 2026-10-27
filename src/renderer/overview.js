export function filterOverview(items, query) {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => !needle || [item.requirement, item.name, item.repoName, item.repoPath, item.branch, item.cwd, item.workPath]
    .some((value) => String(value || '').toLowerCase().includes(needle)));
}

// 一覧の上端のタブ。「すべて」「開いているタブ」、リポジトリ（一覧の並び順）、「その他のターミナル」
export function overviewTabs(items) {
  const tabs = [{ key: 'all', label: 'すべて', items }];
  const open = items.filter((item) => item.open);
  if (open.length) tabs.push({ key: 'open', label: '開いているタブ', items: open });
  for (const repoPath of new Set(items.filter((item) => item.repoPath).map((item) => item.repoPath))) {
    const repoItems = items.filter((item) => item.repoPath === repoPath);
    tabs.push({ key: `repo:${repoPath}`, label: repoItems[0].repoName || repoPath, items: repoItems });
  }
  const loose = items.filter((item) => !item.repoPath);
  if (loose.length) tabs.push({ key: 'loose', label: 'その他のターミナル', items: loose });
  return tabs;
}

// タブで選んだ端末。リポジトリとその他のタブでは、開いているタブも元のまとまりに入れて出す
export function overviewTabItems(items, tab) {
  if (tab === 'open') return items.filter((item) => item.open);
  if (tab === 'loose') return items.filter((item) => !item.repoPath).map((item) => ({ ...item, open: false }));
  if (tab.startsWith('repo:')) return items.filter((item) => item.repoPath === tab.slice(5)).map((item) => ({ ...item, open: false }));
  return items;
}

// タイルの見出しは要件（claude などが付ける端末の題名。話が変わるたびに付け替わる）を主にし、
// 無ければ一覧と同じ名前にする。下の行に、自分で付けた名前・ブランチ（作業外なら場所）・プログラムを並べる
export function tileLabels(item) {
  const main = item.requirement || item.name || '';
  const meta = [...new Set([item.requirement ? item.customName : '', item.branch || item.place, item.program]
    .filter((part) => part && part !== main))];
  return { main, meta: meta.join(' · ') };
}

// 所属の中のまとまり。開いているタブ（画面上部のタブの帯に出ている端末）を先頭に出し、
// 続けてリポジトリ（一覧の並び順）、最後にその他のターミナル。リポジトリが多くても、作業中の端末まで送らずに済む
export function overviewGroups(members) {
  const groups = [];
  const open = members.filter((item) => item.open);
  if (open.length) groups.push({ key: 'open', repoPath: null, label: '開いているタブ', items: open });
  const rest = members.filter((item) => !item.open);
  const repos = [...new Set(rest.filter((item) => item.repoPath).map((item) => item.repoPath))];
  for (const repoPath of repos) {
    const items = rest.filter((item) => item.repoPath === repoPath);
    groups.push({ key: `repo:${repoPath}`, repoPath, label: items[0].repoName || repoPath, items });
  }
  const loose = rest.filter((item) => !item.repoPath);
  if (loose.length) groups.push({ key: 'loose', repoPath: null, label: 'その他のターミナル', items: loose });
  return groups;
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
    <span class="overview__hint">↑↓←→ で選ぶ · ⌃Tab でタブを切り替え · Enter で移る</span>
  </div>
  <div class="overview__tabs" role="tablist" aria-label="まとまり"></div>
  <div id="overview-list" class="overview__list" role="listbox" aria-label="全ターミナル"></div>
  <p class="overview__empty" role="status" hidden></p>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('.overview__list');
  const empty = dialog.querySelector('.overview__empty');
  const tabsEl = dialog.querySelector('.overview__tabs');
  // 選んだタブは、窓を開いている間は次に一覧を開いたときも保つ
  let tab = 'all';
  let tabsSignature = null;
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
    const tabs = overviewTabs(items);
    if (!tabs.some((t) => t.key === tab)) tab = 'all';
    renderTabs(tabs);
    const matches = filterOverview(overviewTabItems(items, tab), input.value);
    if (!matches.some((item) => item.id === selected)) selected = matches[0]?.id ?? null;
    const nextSignature = JSON.stringify([workspaces, tab, matches.map((item) => [item.id, item.workspace, item.repoPath, item.repoName, item.open])]);
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
        for (const { key, repoPath, label, items: groupItems } of overviewGroups(members)) {
          const group = document.createElement('div');
          group.className = 'overview__repo';
          group.dataset.group = key;
          group.dataset.repo = repoPath || '';
          const repoHeading = document.createElement('h3');
          repoHeading.textContent = label;
          const grid = document.createElement('div');
          grid.className = 'overview__grid';
          for (const item of groupItems) {
            let tile = tiles.get(item.id);
            if (!tile) {
              tile = document.createElement('button');
              tile.type = 'button';
              tile.className = 'overview__tile';
              tile.id = `overview-terminal-${item.id}`;
              tile.dataset.id = item.id;
              tile.tabIndex = -1;
              tile.setAttribute('role', 'option');
              tile.innerHTML = '<span class="overview__tile-head"><span class="session__dot"></span><span class="overview__label"><span class="overview__name"></span><span class="overview__meta"></span></span><span class="overview__star" aria-label="お気に入り"></span></span><span class="overview__preview" aria-hidden="true"></span>';
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
      const labels = tileLabels(item);
      tile.querySelector('.overview__name').textContent = labels.main;
      const meta = tile.querySelector('.overview__meta');
      meta.textContent = labels.meta;
      meta.hidden = !labels.meta;
      tile.querySelector('.overview__star').hidden = !item.favorite;
      tile.querySelector('.overview__preview').textContent = preview(item.id);
      tile.setAttribute('aria-current', String(item.current));
      tile.title = [labels.main, labels.meta, item.cwd].filter(Boolean).join('\n');
      renderStatus(tile, item);
    }
    select(selected);
    empty.hidden = matches.length > 0;
    empty.textContent = items.length ? '合うターミナルはない' : 'ターミナルはない';
  }

  // タブの並びが変わったときだけ作り直し、件数（絞り込み後）と選びは毎回更新する
  function renderTabs(tabs) {
    const next = JSON.stringify(tabs.map((t) => [t.key, t.label]));
    if (next !== tabsSignature) {
      tabsSignature = next;
      tabsEl.replaceChildren(...tabs.map((t) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'overview__tab';
        el.dataset.tab = t.key;
        el.setAttribute('role', 'tab');
        el.tabIndex = -1;
        el.innerHTML = '<span class="overview__tab-label"></span><span class="overview__tab-count"></span>';
        el.querySelector('.overview__tab-label').textContent = t.label;
        return el;
      }));
    }
    for (const t of tabs) {
      const el = tabsEl.querySelector(`[data-tab="${CSS.escape(t.key)}"]`);
      el.setAttribute('aria-selected', String(t.key === tab));
      el.querySelector('.overview__tab-count').textContent = String(filterOverview(t.items, input.value).length);
    }
  }

  function setTab(key) {
    if (key === tab) return;
    tab = key;
    render();
    list.scrollTop = 0;
    tabsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function stepTab(offset) {
    const keys = [...tabsEl.querySelectorAll('.overview__tab')].map((el) => el.dataset.tab);
    const at = keys.indexOf(tab);
    setTab(keys[(at + offset + keys.length) % keys.length]);
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
  tabsEl.addEventListener('click', (event) => {
    const el = event.target.closest('.overview__tab');
    if (!el) return;
    setTab(el.dataset.tab);
    input.focus();
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    const tile = event.target.closest('.overview__tile');
    if (tile) { choose(Number(tile.dataset.id)); return; }
    if (!event.target.closest('input, label, button')) close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      stepTab(event.shiftKey ? -1 : 1);
      return;
    }
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
  return { toggle, close, setTab, selectAll: () => { input.focus(); input.select(); }, get open() { return dialog.open; }, get tab() { return tab; } };
}
