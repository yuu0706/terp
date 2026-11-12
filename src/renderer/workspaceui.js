export const STAR_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></svg>';
export const draftLabel = (draft) => draft ? 'ドラフトから外す' : 'ドラフトに入れる';

// Popover の最前面の層に置き、端末の分割やサイドバーのスクロールで切れないようにする。
export function createMenu() {
  const menu = document.createElement('div');
  menu.className = 'menu workspace-menu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  let origin;
  let currentItems = [];
  let position;
  function close() { menu.hidePopover(); }
  function fill(items) {
    currentItems = items;
    menu.replaceChildren();
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu__sep';
        menu.append(sep);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu__item';
      button.setAttribute('role', item.checked === undefined ? 'menuitem' : item.checkbox ? 'menuitemcheckbox' : 'menuitemradio');
      if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
      const label = document.createElement('span');
      label.className = 'menu__label';
      label.textContent = item.label;
      button.append(label);
      if (item.id) button.dataset.workspace = item.id;
      if (item.status) button.append(item.status);
      button.disabled = Boolean(item.reason);
      if (item.reason) {
        const reason = document.createElement('small');
        reason.className = 'workspace-menu__reason';
        reason.textContent = item.reason;
        button.append(reason);
        button.title = item.reason;
      }
      if (item.children) {
        label.textContent += ' ▸';
        button.setAttribute('aria-haspopup', 'menu');
      }
      const run = async () => {
        if (item.children) {
          const parent = currentItems;
          fill([{ label: '‹ 戻る', run: () => { fill(parent); fit(); menu.querySelector('button')?.focus(); }, keepOpen: true }, ...item.children]);
          fit();
          menu.querySelector('button:not(:disabled)')?.focus();
        } else {
          if (!item.keepOpen) close();
          await item.run?.();
        }
      };
      button.addEventListener('click', run);
      if (item.children) button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); run(); }
      });
      menu.append(button);
    }
  }
  function fit() {
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-2'));
    menu.style.left = `${Math.max(gap, Math.min(position.x, innerWidth - menu.offsetWidth - gap))}px`;
    menu.style.top = `${Math.max(gap, Math.min(position.y, innerHeight - menu.offsetHeight - gap))}px`;
  }
  function open(items, { x, y, target } = {}) {
    origin = target;
    const rect = target?.getBoundingClientRect();
    position = { x: x ?? rect?.left ?? 0, y: y ?? rect?.bottom ?? 0 };
    fill(items);
    menu.showPopover();
    fit();
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { close(); origin?.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      e.preventDefault();
    }
  });
  return { open, close, el: menu };
}

export function createWorkspaceUI({ menuItems, submitName }) {
  const host = document.createElement('div');
  host.className = 'workspace-picker';
  host.innerHTML = '<button id="workspace-switch" class="btn workspace-picker__button" type="button" aria-haspopup="menu" aria-expanded="false"><span class="menu__label"></span><span class="work__status" hidden><span class="session__dot"></span><span class="work__status-count"></span></span><span aria-hidden="true">⌄</span></button><p class="workspace-picker__error config-error" role="alert" hidden></p>';
  document.getElementById('tree').before(host);
  const button = host.querySelector('button');
  const menu = createMenu();
  button.addEventListener('click', () => {
    if (menu.el.matches(':popover-open')) menu.close();
    else { menu.open(menuItems(), { target: button }); button.setAttribute('aria-expanded', 'true'); }
  });
  menu.el.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(menu.el.matches(':popover-open'))));
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'workspace-dialog-title');
  dialog.innerHTML = '<form class="dialog__body"><h2 id="workspace-dialog-title" class="dialog__title"></h2><label class="field"><span class="field__label">名前</span><input class="input" name="name" required autocomplete="off" /></label><p class="dialog__error" role="alert" hidden></p><div class="dialog__actions"><button class="btn" type="button">キャンセル</button><button class="btn btn--primary" type="submit">作成</button></div></form>';
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  let editing;
  form.querySelector('[type="button"]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await submitName(editing, form.elements.name.value);
      dialog.close();
    } catch (err) {
      const error = form.querySelector('.dialog__error');
      error.textContent = err.message;
      error.hidden = false;
    } finally { submit.disabled = false; }
  });
  function edit(workspace) {
    editing = workspace?.id || null;
    form.querySelector('h2').textContent = workspace ? 'ワークスペースの名前を変更' : '新しいワークスペース';
    form.querySelector('[type="submit"]').textContent = workspace ? '変更' : '作成';
    form.elements.name.value = workspace?.name || '';
    form.querySelector('.dialog__error').hidden = true;
    dialog.showModal();
    form.elements.name.focus();
    form.elements.name.select();
  }
  function error(message) {
    const el = host.querySelector('.workspace-picker__error');
    el.hidden = !message;
    el.textContent = message || '';
  }
  return { button, menu, edit, error };
}
