const terp = window.terp;
const shortcuts = window.terpShortcuts;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createShortcutEditor({ getBindings, saveBindings }) {
  const wrap = element('div', 'shortcut-settings');
  const toolbar = element('div', 'shortcut-settings__toolbar');
  const label = element('label', 'settings__label', '絞り込み');
  label.htmlFor = 'shortcut-filter';
  const filter = element('input', 'input');
  filter.id = 'shortcut-filter';
  filter.type = 'search';
  filter.placeholder = '例）ターミナル・⌘T';
  const resetAll = element('button', 'btn', 'すべて既定に戻す');
  resetAll.id = 'shortcut-reset-all';
  resetAll.type = 'button';
  toolbar.append(label, filter, resetAll);
  const help = element('p', 'settings__help', 'キー欄を押して組み合わせを入力する。⌘・⇧・⌥・⌃ のいずれかを含める。Esc で取り消す。');
  const error = element('p', 'shortcut-settings__error');
  error.id = 'shortcut-error';
  error.setAttribute('role', 'alert');
  const status = element('p', 'settings__help');
  status.id = 'shortcut-status';
  status.setAttribute('role', 'status');
  const list = element('div', 'shortcut-settings__list');
  const empty = element('p', 'settings__help', '該当する操作なし。絞り込みを変える。');
  empty.hidden = true;
  wrap.append(toolbar, help, error, status, list, empty);
  const rows = [];
  let capture = null;
  let busy = false;
  let disposed = false;

  function endCapture() {
    if (!capture) return;
    capture = null;
    delete document.documentElement.dataset.shortcutCapture;
    window.removeEventListener('keydown', captureKey, true);
    window.removeEventListener('blur', cancelCapture);
    document.removeEventListener('visibilitychange', cancelCapture);
    // 待ち受けを閉じる経路を共通にし、設定を閉じた後もメニューが止まったままになるのを防ぐ。
    terp.captureShortcut(false).catch(() => {});
    refresh();
  }

  function cancelCapture() {
    if (!capture) return;
    endCapture();
    status.textContent = '入力を取り消した';
  }

  async function commit(next) {
    if (busy || disposed) return;
    const reason = shortcuts.validateKeybindings(next);
    if (reason) { error.textContent = reason; return; }
    busy = true;
    error.textContent = '';
    status.textContent = '保存中…';
    refresh();
    try {
      const result = await saveBindings(next);
      if (disposed) return;
      if (!result) {
        error.textContent = '保存できない。設定ファイルのエラーを確認して、もう一度試す。';
        status.textContent = '';
      } else status.textContent = '保存した';
    } catch {
      error.textContent = '保存できない。もう一度試す。';
      status.textContent = '';
    } finally {
      busy = false;
      if (!disposed) refresh();
    }
  }

  function captureKey(event) {
    if (!capture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { cancelCapture(); return; }
    if (!capture.ready || event.repeat || ['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
    const accelerator = shortcuts.acceleratorFromEvent(event);
    if (!accelerator) {
      error.textContent = '⌘・⇧・⌥・⌃ と、文字・数字などのキーを組み合わせる。変換中は確定してから入力する。';
      return;
    }
    const { item, button } = capture;
    const conflicts = shortcuts.findConflicts(item.id, accelerator, getBindings());
    if (conflicts.length) {
      error.textContent = `${shortcuts.formatAccelerator(accelerator)} は「${conflicts.map((entry) => entry.label).join('」「')}」と重なる。別のキーを押す。`;
      return;
    }
    const next = { ...getBindings(), [item.id]: accelerator };
    if (accelerator === shortcuts.normalizeAccelerator(item.defaultAccelerator)) delete next[item.id];
    endCapture();
    commit(next).then(() => { if (button.isConnected && !disposed) button.focus({ preventScroll: true }); });
  }

  async function beginCapture(item, button) {
    if (busy) return;
    if (capture?.item.id === item.id) { cancelCapture(); return; }
    endCapture();
    const session = { item, button, ready: false };
    capture = session;
    document.documentElement.dataset.shortcutCapture = 'true';
    error.textContent = '';
    status.textContent = '入力を準備中…';
    window.addEventListener('keydown', captureKey, true);
    window.addEventListener('blur', cancelCapture);
    document.addEventListener('visibilitychange', cancelCapture);
    refresh();
    try {
      const ready = await terp.captureShortcut(true);
      if (capture !== session || disposed) return;
      if (!ready) throw new Error();
      session.ready = true;
      status.textContent = 'キーを押してください（Esc で取り消す）';
      refresh();
    } catch {
      endCapture();
      error.textContent = 'キーの入力を開始できない。もう一度キー欄を押す。';
      status.textContent = '';
    }
  }

  for (const item of shortcuts.ALL_SHORTCUTS.filter((entry) => !entry.aliasFor)) {
    let group = [...list.children].find((node) => node.dataset.group === item.group);
    if (!group) {
      group = element('section', 'shortcut-settings__group');
      group.dataset.group = item.group;
      group.append(element('h3', 'settings__label', item.group));
      list.append(group);
    }
    const row = element('div', 'shortcut-settings__row');
    row.dataset.shortcutId = item.id;
    const name = element('div', 'shortcut-settings__name');
    name.append(element('span', '', item.label));
    if (!item.editable) name.append(element('span', 'settings__help', item.role ? 'OS 標準のため変更できない' : '画面内の操作のため変更できない'));
    if (item.id === 'font-bigger') name.append(element('span', 'settings__help', '既定では ⌘⇧=（⌘＋）も使える'));
    const key = element(item.editable ? 'button' : 'kbd', item.editable ? 'btn shortcut-settings__key' : 'shortcut-settings__key');
    key.dataset.shortcutKey = '';
    const actions = element('div', 'shortcut-settings__actions');
    let unset, reset;
    if (item.editable) {
      key.type = 'button';
      key.addEventListener('click', () => beginCapture(item, key));
      key.addEventListener('blur', () => { if (capture?.button === key) cancelCapture(); });
      unset = element('button', 'btn', '割り当てを外す');
      reset = element('button', 'btn', '既定に戻す');
      unset.type = reset.type = 'button';
      unset.dataset.shortcutUnset = '';
      reset.dataset.shortcutReset = '';
      unset.setAttribute('aria-label', `${item.label}の割り当てを外す`);
      reset.setAttribute('aria-label', `${item.label}を既定に戻す`);
      unset.addEventListener('click', () => { endCapture(); commit({ ...getBindings(), [item.id]: null }); });
      reset.addEventListener('click', () => {
        endCapture();
        const next = { ...getBindings() };
        delete next[item.id];
        commit(next);
      });
      actions.append(unset, reset);
    }
    row.append(name, key, actions);
    group.append(row);
    rows.push({ item, row, key, unset, reset });
  }

  function refresh() {
    const bindings = getBindings();
    const query = filter.value.trim().toLocaleLowerCase();
    for (const { item, row, key, unset, reset } of rows) {
      const accelerator = shortcuts.acceleratorFor(item.id, bindings);
      const display = shortcuts.formatAccelerator(accelerator);
      row.hidden = !`${item.group} ${item.label} ${display} ${accelerator || ''}`.toLocaleLowerCase().includes(query);
      key.textContent = capture?.item.id === item.id ? 'キーを押してください' : display || '割り当てなし';
      key.dataset.capturing = String(capture?.item.id === item.id);
      if (item.editable) {
        key.disabled = busy;
        key.setAttribute('aria-label', `${item.label}のキー: ${key.textContent}`);
        key.setAttribute('aria-pressed', String(capture?.item.id === item.id));
        unset.disabled = busy || !accelerator;
        reset.disabled = busy || !Object.hasOwn(bindings, item.id);
      }
    }
    for (const group of list.children) group.hidden = ![...group.querySelectorAll('[data-shortcut-id]')].some((row) => !row.hidden);
    empty.hidden = rows.some(({ row }) => !row.hidden);
    resetAll.disabled = busy || !Object.keys(bindings).length;
    wrap.setAttribute('aria-busy', String(busy));
  }
  filter.addEventListener('input', () => { endCapture(); refresh(); });
  resetAll.addEventListener('click', () => { endCapture(); commit({}); });
  wrap.refresh = refresh;
  wrap.dispose = () => { endCapture(); disposed = true; };
  refresh();
  return wrap;
}
