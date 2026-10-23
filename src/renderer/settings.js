// 設定の画面。左のメニューで項目を選び、右にその設定を出す。
// 変えたらすぐ ~/.config/terp/config.json に書き、設定ファイルの監視を通して画面に反映する。
//
// 設定を足すときは、SECTIONS に項目を足す。key は config.js の DEFAULT_CONFIG の名前と同じにする
// （知らない名前は書き込みで拒否される）。種類（type）ごとの書き方は FIELD_TYPES を見る。
const terp = window.terp;

const ICONS = {
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" />',
  agents: '<rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 4v4M9 13v2M15 13v2M2 14h2M20 14h2" />',
  advanced: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />',
};

// ctx.agents() は見つかった AI エージェントの一覧を返す（app.js が渡す）
export const SECTIONS = [
  {
    id: 'appearance',
    label: '外観',
    fields: [
      {
        key: 'theme',
        label: 'テーマ',
        type: 'theme',
        help: 'Ghostty のテーマの書式のファイルを読む。自分で作ったテーマは ~/.config/terp/themes に置く',
        options: async () => {
          const res = await terp.listThemes();
          return [{ value: null, label: '内蔵の色（Catppuccin Mocha 相当）' }, ...(res.ok ? res.value : []).map((n) => ({ value: n, label: n }))];
        },
      },
      { key: 'accent', label: '強調色', type: 'color', help: '新しいターミナルのボタンや未読の印の色。既定に戻すとテーマのカーソルの色になる' },
      { key: 'fontFamily', label: 'フォント', type: 'text', help: 'CSS の font-family の書き方で、使いたい順に並べる' },
      { key: 'fontSize', label: '文字の大きさ', type: 'number', min: 9, max: 32, step: 1, unit: 'px' },
      {
        key: 'backgroundOpacity',
        label: '背景の不透明度',
        type: 'range',
        min: 0.2,
        max: 1,
        step: 0.05,
        format: (v) => `${Math.round(v * 100)}%`,
      },
      {
        key: 'backgroundBlur',
        label: '背景のぼかし',
        type: 'range',
        min: 0,
        max: 60,
        step: 1,
        help: '窓の後ろをぼかす半径。0 でぼかさない',
        // 設定ファイルでは false か半径の数値（true は半径 20）
        read: (v) => (v === true ? 20 : Number(v) || 0),
        write: (v) => (v === 0 ? false : v),
        format: (v) => (v === 0 ? 'なし' : String(v)),
      },
    ],
  },
  {
    id: 'agents',
    label: 'AI エージェント',
    fields: [
      {
        key: 'skipApprovals',
        label: '確認なしで起動する',
        type: 'toggle',
        help: 'ファイルの読み書きやコマンドの実行の確認を飛ばして起動する（claude は --dangerously-skip-permissions など）。⌥ を押しながら起動すると逆になる',
        danger: true,
      },
      {
        key: 'mainAgent',
        label: 'メインのエージェント',
        type: 'select',
        help: 'タブの並びの隣のボタンで、プルダウンなしで起動するもの',
        options: (ctx) => [
          { value: null, label: '見つかった最初のもの' },
          ...ctx.agents().map((a) => ({ value: a.command, label: `${a.command.split('/').pop()}（${a.label}）` })),
        ],
      },
    ],
  },
  {
    id: 'advanced',
    label: '詳しい設定',
    fields: [
      {
        type: 'action',
        label: '設定ファイルを開く',
        help: 'この画面に無い設定（足すエージェントの agents など）は、設定ファイルに書く',
        run: () => terp.openConfigFile(),
      },
    ],
  },
];

const overlay = document.getElementById('settings');
const nav = document.getElementById('settings-nav');
const content = document.getElementById('settings-content');
const statusEl = document.getElementById('settings-status');

let ctx = { agents: () => [] };
let current = SECTIONS[0].id;
let values = {};
let onClose = () => {};
let statusTimer = null;
const themeColorCache = new Map();
let refreshThemePreview = () => {};
let cancelThemeAi = () => {};

export function initSettings(context) {
  ctx = context;
  onClose = context.onClose || onClose;
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    }
  });
}

export function isSettingsOpen() {
  return !overlay.hidden;
}

export async function openSettings(sectionId) {
  if (sectionId) current = sectionId;
  const res = await terp.rawConfig();
  values = res.ok ? res.value : {};
  themeColorCache.clear();
  overlay.hidden = false;
  renderNav();
  await renderSection();
  nav.querySelector('[aria-current="true"]')?.focus();
}

export function closeSettings() {
  cancelThemeAi();
  overlay.hidden = true;
  onClose();
}

function showStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (tone !== 'error') statusTimer = setTimeout(() => (statusEl.textContent = ''), 2000);
}

async function save(key, value) {
  const res = await terp.updateConfig({ [key]: value });
  if (!res.ok) {
    showStatus(res.error, 'error');
    return false;
  }
  values = { ...values, [key]: value };
  if (value === null) delete values[key];
  if (key === 'accent') refreshThemePreview();
  showStatus('保存しました');
  return true;
}

function renderNav() {
  nav.textContent = '';
  for (const section of SECTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings__nav-item';
    btn.setAttribute('aria-current', String(section.id === current));
    btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[section.id] || ''}</svg><span></span>`;
    btn.querySelector('span').textContent = section.label;
    btn.addEventListener('click', async () => {
      current = section.id;
      renderNav();
      await renderSection();
    });
    nav.append(btn);
  }
}

async function renderSection() {
  const section = SECTIONS.find((s) => s.id === current) || SECTIONS[0];
  content.textContent = '';
  const title = document.createElement('h2');
  title.className = 'settings__title';
  title.textContent = section.label;
  content.append(title);
  for (const field of section.fields) content.append(await renderField(field));
}

// 種類ごとの部品。どれも { el, } を返し、変えたら save を呼ぶ
const FIELD_TYPES = {
  theme: createThemePicker,
  async select(field, value, id) {
    const select = document.createElement('select');
    select.className = 'input';
    select.id = id;
    const options = await field.options(ctx);
    for (const o of options) {
      const opt = new Option(o.label, o.value === null ? '' : o.value);
      opt.dataset.null = String(o.value === null);
      select.append(opt);
    }
    // 一覧に無い値（手で書いた名前など）も、消さずに選ばれた状態で出す
    if (value !== null && value !== undefined && !options.some((o) => o.value === value)) {
      select.append(new Option(`${value}（見つかりません）`, value));
    }
    select.value = value === null || value === undefined ? '' : value;
    select.addEventListener('change', () => save(field.key, select.selectedOptions[0].dataset.null === 'true' ? null : select.value));
    return select;
  },

  text(field, value, id) {
    const input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.spellcheck = false;
    input.value = value ?? '';
    // 入力が止まって 800ms 後と、欄から離れたときに保存する
    let timer = null;
    const commit = () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (v && v !== values[field.key]) save(field.key, v);
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(commit, 800);
    });
    input.addEventListener('blur', commit);
    return input;
  },

  number(field, value, id) {
    const wrap = document.createElement('div');
    wrap.className = 'settings__inline';
    const input = document.createElement('input');
    input.className = 'input settings__number';
    input.type = 'number';
    input.id = id;
    Object.assign(input, { min: field.min, max: field.max, step: field.step });
    input.value = value;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= field.min && v <= field.max) save(field.key, v);
      else showStatus(`${field.min}〜${field.max} の数で入れてください`, 'error');
    });
    wrap.append(input);
    if (field.unit) {
      const unit = document.createElement('span');
      unit.className = 'settings__unit';
      unit.textContent = field.unit;
      wrap.append(unit);
    }
    return wrap;
  },

  range(field, value, id) {
    const read = field.read || ((v) => Number(v));
    const write = field.write || ((v) => v);
    const format = field.format || String;
    const wrap = document.createElement('div');
    wrap.className = 'settings__inline';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'settings__range';
    input.id = id;
    Object.assign(input, { min: field.min, max: field.max, step: field.step });
    input.value = read(value);
    const out = document.createElement('output');
    out.className = 'settings__unit';
    out.textContent = format(Number(input.value));
    // 動かしている間は表示だけ変え、離したら保存する
    input.addEventListener('input', () => (out.textContent = format(Number(input.value))));
    input.addEventListener('change', () => save(field.key, write(Number(input.value))));
    wrap.append(input, out);
    return wrap;
  },

  toggle(field, value, id) {
    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.checked = value === true;
    const track = document.createElement('span');
    track.className = 'switch__track';
    if (field.danger) track.dataset.danger = 'true';
    label.append(input, track);
    input.addEventListener('change', () => save(field.key, input.checked));
    return label;
  },

  color(field, value, id) {
    const wrap = document.createElement('div');
    wrap.className = 'settings__inline';
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'settings__color';
    input.id = id;
    input.value = value || getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#89b4fa';
    const state = document.createElement('span');
    state.className = 'settings__unit';
    state.textContent = value ? value : 'テーマに合わせる';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn--xs';
    reset.textContent = '既定に戻す';
    reset.disabled = !value;
    input.addEventListener('change', async () => {
      if (await save(field.key, input.value)) {
        state.textContent = input.value;
        reset.disabled = false;
      }
    });
    reset.addEventListener('click', async () => {
      if (await save(field.key, null)) {
        state.textContent = 'テーマに合わせる';
        reset.disabled = true;
      }
    });
    wrap.append(input, state, reset);
    return wrap;
  },

  action(field) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = field.label;
    btn.addEventListener('click', () => field.run(ctx));
    return btn;
  },
};

async function renderField(field) {
  const row = document.createElement('div');
  row.className = 'settings__field';
  const id = `setting-${field.key || field.label}`;
  const control = await FIELD_TYPES[field.type](field, values[field.key], id);
  if (field.type !== 'action') {
    const label = document.createElement('label');
    label.className = 'settings__label';
    label.htmlFor = id;
    label.textContent = field.label;
    if (field.type === 'theme') {
      const heading = document.createElement('div');
      heading.className = 'settings__field-heading';
      const ai = document.createElement('button');
      ai.id = 'theme-ai-open';
      ai.type = 'button';
      ai.className = 'btn btn--xs';
      ai.textContent = 'AI で好みを作成';
      ai.addEventListener('click', () => openThemeAi(() => control.reload()));
      heading.append(label, ai);
      row.append(heading);
    } else row.append(label);
  }
  row.append(control);
  if (field.help) {
    const help = document.createElement('p');
    help.className = 'settings__help';
    help.textContent = field.help;
    row.append(help);
  }
  if (field.key) row.dataset.key = field.key;
  return row;
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// 色はこの見本の要素にだけ当て、アプリ全体の CSS 変数には触らない
function renderThemePreview(colors, name) {
  const t = colors.terminal;
  const c = colors.chrome;
  const preview = element('div', 'theme-preview');
  Object.assign(preview.style, { background: c.bg, color: c.text, borderColor: c.border });
  preview.append(element('div', 'theme-preview__name', name || '内蔵の色'));
  const terminal = element('pre', 'theme-preview__terminal');
  Object.assign(terminal.style, { background: t.background, color: t.foreground });
  const span = (text, color, background) => {
    const el = element('span', '', text);
    if (color) el.style.color = color;
    if (background) el.style.background = background;
    return el;
  };
  terminal.append(span('user@terp ', t.green), span('~/project', t.blue), span(' $ ls\n'),
    span('src/  docs/  ', t.blue), span('build.sh*  ', t.green), span('README.md\n'),
    span('$ git diff\n'), span('- const count = 1;\n', t.red), span('+ const count = 42;\n', t.green),
    span('\n// 色の見本\n', t.brightBlack), span('const ', t.magenta), span('message = '), span('"hello"', t.green), span(';\n'),
    span('return ', t.magenta), span('42', t.yellow), span('; '), span('選択した文字', t.selectionForeground, t.selectionBackground),
    span('\n$ '), span(' ', t.cursorAccent, t.cursor));
  preview.append(terminal);
  const palette = element('div', 'theme-preview__palette');
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  [...names, ...names.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)].forEach((key, i) => {
    const cell = element('div', 'theme-preview__color');
    const swatch = element('span', 'theme-preview__swatch');
    swatch.style.background = t[key];
    swatch.title = `${i}: ${t[key]}`;
    cell.append(swatch, element('span', '', String(i)));
    palette.append(cell);
  });
  preview.append(palette);
  const chrome = element('div', 'theme-preview__chrome');
  const sidebar = element('div', 'theme-preview__sidebar');
  Object.assign(sidebar.style, { background: c.bg, borderColor: c.border });
  const muted = element('div', 'theme-preview__item', '作業');
  muted.style.color = c['text-muted'];
  const active = element('div', 'theme-preview__item', 'ターミナル');
  active.style.background = c['bg-active'];
  const hover = element('div', 'theme-preview__item', 'ファイル');
  hover.style.background = c['bg-hover'];
  sidebar.append(muted, active, hover);
  const action = element('span', 'theme-preview__button', '新しいターミナル');
  Object.assign(action.style, { background: c.accent, color: c.bg });
  chrome.append(sidebar, action);
  preview.append(chrome);
  return preview;
}

function cachedThemeColors(name) {
  const key = JSON.stringify([name, values.accent || null]);
  if (!themeColorCache.has(key)) {
    const pending = terp.themeColors(name).then((res) => {
      if (!res.ok) themeColorCache.delete(key);
      return res;
    });
    themeColorCache.set(key, pending);
  }
  return themeColorCache.get(key);
}

async function createThemePicker(field, value, id) {
  const picker = element('div', 'theme-picker');
  const left = element('div', 'theme-picker__choices');
  const filter = element('input', 'input');
  filter.id = id;
  filter.type = 'search';
  filter.placeholder = 'テーマを絞り込み';
  filter.setAttribute('aria-label', 'テーマを絞り込み');
  const list = element('div', 'theme-picker__list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'テーマ');
  const detail = element('div', 'theme-picker__detail');
  detail.id = 'theme-preview';
  left.append(filter, list);
  picker.append(left, detail);
  let options = [];
  let visible = [];
  let active = value ?? null;
  let previewRequest = 0;
  let applying = false;

  const showPreview = async (name) => {
    active = name;
    for (const row of list.querySelectorAll('.theme-picker__row')) {
      const selected = row.dataset.theme === (name ?? '');
      row.dataset.preview = String(selected);
      row.tabIndex = selected ? 0 : -1;
    }
    const request = ++previewRequest;
    detail.setAttribute('aria-busy', 'true');
    const res = await cachedThemeColors(name);
    if (request !== previewRequest) return;
    detail.removeAttribute('aria-busy');
    detail.replaceChildren(res.ok ? renderThemePreview(res.value, name) : element('p', 'dialog__error', res.error));
  };
  refreshThemePreview = () => { if (picker.isConnected) showPreview(active); };

  const apply = async (name) => {
    if (applying) return;
    applying = true;
    try {
      if (await save(field.key, name)) {
        const scrollTop = list.scrollTop;
        renderList();
        list.scrollTop = scrollTop;
        list.querySelector('[data-preview="true"]')?.focus({ preventScroll: true });
      }
    } finally { applying = false; }
  };
  const renderList = () => {
    const query = filter.value.toLocaleLowerCase();
    visible = options.filter((o) => o.label.toLocaleLowerCase().includes(query));
    list.textContent = '';
    if (!visible.some((o) => o.value === active)) active = visible[0]?.value ?? null;
    for (const option of visible) {
      const row = element('button', 'theme-picker__row');
      row.type = 'button';
      row.dataset.theme = option.value ?? '';
      row.dataset.preview = String(option.value === active);
      row.tabIndex = option.value === active ? 0 : -1;
      row.setAttribute('role', 'option');
      const applied = option.value === (values.theme ?? null);
      row.setAttribute('aria-selected', String(applied));
      row.append(element('span', '', option.label));
      if (applied) row.append(element('span', 'theme-picker__current', '使用中'));
      row.addEventListener('mouseenter', () => showPreview(option.value));
      row.addEventListener('focus', () => showPreview(option.value));
      row.addEventListener('click', () => { showPreview(option.value); apply(option.value); });
      list.append(row);
    }
    if (!visible.length) list.append(element('p', 'settings__help', '該当するテーマなし。絞り込みを変える'));
  };
  const move = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) || !visible.length) return;
    e.preventDefault();
    if (e.key === 'Enter') { apply(active); return; }
    const at = visible.findIndex((o) => o.value === active);
    const next = Math.max(0, Math.min(visible.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    showPreview(visible[next].value);
    const row = list.children[next];
    if (e.target !== filter) row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  };
  list.addEventListener('keydown', move);
  filter.addEventListener('keydown', move);
  filter.addEventListener('input', () => {
    renderList();
    if (visible.length) showPreview(active);
    else {
      previewRequest++;
      detail.removeAttribute('aria-busy');
      detail.textContent = '';
    }
  });
  picker.reload = async () => {
    options = await field.options(ctx);
    const applied = values.theme ?? null;
    if (!options.some((o) => o.value === applied)) options.push({ value: applied, label: `${applied}（見つかりません）` });
    filter.value = '';
    active = applied;
    renderList();
    showPreview(active);
    requestAnimationFrame(() => {
      const row = list.querySelector('[aria-selected="true"]');
      if (row) list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
    });
  };
  await picker.reload();
  return picker;
}

function openThemeAi(onApplied) {
  const dialog = document.getElementById('theme-ai-dialog');
  if (dialog.open) return;
  const form = dialog.querySelector('form');
  form.reset();
  const questions = document.getElementById('theme-ai-questions');
  const result = document.getElementById('theme-ai-preview');
  const error = document.getElementById('theme-ai-error');
  const status = document.getElementById('theme-ai-status');
  const create = document.getElementById('theme-ai-create');
  const apply = document.getElementById('theme-ai-apply');
  const retry = document.getElementById('theme-ai-retry');
  const cancel = document.getElementById('theme-ai-cancel');
  let request = 0;
  let generated = null;
  let answers = null;
  let busy = false;
  let savedName = null;
  const resetResult = () => {
    generated = null;
    savedName = null;
    result.replaceChildren();
    result.hidden = true;
    apply.hidden = true;
    retry.hidden = true;
    create.hidden = false;
    create.disabled = false;
    create.textContent = '作成';
    error.hidden = true;
    status.textContent = '';
    questions.disabled = false;
  };
  const close = () => {
    request++;
    if (dialog.open) dialog.close();
  };
  cancelThemeAi = close;
  dialog.oncancel = (e) => { e.preventDefault(); close(); };
  dialog.onclose = () => { request++; };
  dialog.onkeydown = (e) => e.stopPropagation();
  cancel.onclick = close;
  const generate = async () => {
    if (busy) return;
    const data = new FormData(form);
    answers = answers || {
      brightness: data.get('brightness'),
      mood: [...data.getAll('mood'), data.get('moodText')].filter(Boolean).join('、'),
      contrast: data.get('contrast'),
    };
    resetResult();
    busy = true;
    questions.disabled = true;
    create.disabled = true;
    create.textContent = '作成中…';
    status.textContent = '作成中…';
    const token = ++request;
    const res = await terp.generateTheme(answers);
    if (token !== request || !dialog.open) return;
    busy = false;
    status.textContent = '';
    create.disabled = false;
    if (!res.ok) {
      error.textContent = res.error;
      error.hidden = false;
      questions.disabled = false;
      create.textContent = 'もう一度';
      answers = null;
      return;
    }
    generated = res.value.theme;
    result.replaceChildren(renderThemePreview(res.value.colors, generated.name));
    result.hidden = false;
    create.hidden = true;
    retry.hidden = false;
    apply.hidden = false;
    apply.disabled = false;
    apply.focus();
  };
  form.onsubmit = (e) => { e.preventDefault(); generate(); };
  retry.onclick = generate;
  apply.onclick = async () => {
    if (busy || !generated) return;
    busy = true;
    apply.disabled = true;
    retry.disabled = true;
    const token = ++request;
    const res = savedName ? { ok: true, value: savedName } : await terp.saveTheme(generated);
    if (token !== request || !dialog.open) return;
    if (res.ok) savedName = res.value;
    if (!res.ok || !(await save('theme', savedName))) {
      if (token !== request || !dialog.open) return;
      error.textContent = res.ok ? 'テーマを保存できませんでした。設定のエラーを確かめる' : res.error;
      error.hidden = false;
      busy = false;
      apply.disabled = false;
      retry.disabled = false;
      return;
    }
    if (token !== request || !dialog.open) return;
    await onApplied();
    close();
  };
  resetResult();
  retry.disabled = false;
  dialog.showModal();
}
