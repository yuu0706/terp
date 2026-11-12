// 端末の中の文字を探す欄（⌘F）。表示している枠の右上に1つだけ出し、探す先の端末を切り替えて使い回す
// 色は xterm.js の決まりで #RRGGBB に限る（透明度を付けられない）
const DECORATIONS = {
  matchBackground: '#585b70',
  matchOverviewRuler: '#f9e2af',
  activeMatchBackground: '#fab387',
  activeMatchBorder: '#fab387',
  activeMatchColorOverviewRuler: '#fab387',
};

export function searchCountLabel(index, count, query) {
  if (!query) return '';
  if (count === 0) return '0件';
  return index >= 0 ? `${index + 1}/${count}` : `${count}件`;
}

export function createTermSearch() {
  const bar = document.createElement('div');
  bar.id = 'term-search';
  bar.className = 'term-search';
  bar.hidden = true;
  bar.innerHTML = `
    <input class="input term-search__input" type="search" placeholder="端末の中を探す" aria-label="端末の中を探す" spellcheck="false">
    <span class="term-search__count" aria-live="polite"></span>
    <button class="icon-btn" type="button" data-dir="prev" aria-label="前へ（⇧Enter）" title="前へ（⇧Enter）"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg></button>
    <button class="icon-btn" type="button" data-dir="next" aria-label="次へ（Enter・⌘G）" title="次へ（Enter・⌘G）"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
    <button class="icon-btn" type="button" data-dir="close" aria-label="閉じる（Esc）" title="閉じる（Esc）"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>`;
  const input = bar.querySelector('input');
  const count = bar.querySelector('.term-search__count');
  let target = null;
  let unsubscribe = null;

  const options = (incremental = false) => ({ decorations: DECORATIONS, incremental });
  const showCount = (index, total) => { count.textContent = searchCountLabel(index, total, input.value); };

  function find(direction, incremental = false) {
    if (!target) return false;
    const query = input.value;
    if (!query) {
      target.search.clearDecorations();
      showCount(-1, 0);
      return false;
    }
    const found = direction === 'prev' ? target.search.findPrevious(query, options()) : target.search.findNext(query, options(incremental));
    if (!found) showCount(-1, 0);
    return found;
  }

  function detach() {
    unsubscribe?.dispose();
    unsubscribe = null;
    target?.search.clearDecorations();
    target?.term.clearSelection();
    target = null;
  }

  function open(s, host, { run = true } = {}) {
    if (target !== s) {
      detach();
      target = s;
      unsubscribe = s.search.onDidChangeResults(({ resultIndex, resultCount }) => showCount(resultIndex, resultCount));
    }
    if (bar.parentElement !== host) host.append(bar);
    bar.hidden = false;
    // 端末で選んでいた文字があれば、それを探す
    const selection = s.term.getSelection();
    if (selection && !selection.includes('\n')) input.value = selection;
    input.focus();
    input.select();
    if (run && input.value) find('next', true);
  }

  function close({ focus = true } = {}) {
    if (bar.hidden) return;
    const s = target;
    bar.hidden = true;
    detach();
    count.textContent = '';
    if (focus) s?.term.focus();
  }

  // ⌘G と、メニューの「前を検索」。欄を閉じていても、前に探した文字で続きを探す
  function step(s, direction, host) {
    if (bar.hidden || target !== s) open(s, host, { run: false });
    find(direction);
  }

  // 探す先の端末が別の枠へ移ったら欄も付いて行き、表示から外れたら閉じる
  function follow(host) {
    if (bar.hidden) return;
    if (!host) close({ focus: false });
    else if (bar.parentElement !== host) host.append(bar);
  }

  input.addEventListener('input', () => find('next', true));
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      find(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  bar.addEventListener('click', (e) => {
    const dir = e.target.closest('button')?.dataset.dir;
    if (dir === 'close') close();
    else if (dir) find(dir);
  });

  return {
    open,
    close,
    step,
    follow,
    get target() { return target; },
    get query() { return input.value; },
    get isOpen() { return !bar.hidden; },
    countText: () => count.textContent,
  };
}
