// 設定の画面。左のメニューで項目を選び、右にその設定を出す。
// 変えたらすぐ ~/.config/terp/config.json に書き、設定ファイルの監視を通して画面に反映する。
//
// 設定を足すときは、SECTIONS に項目を足す。key は config.js の DEFAULT_CONFIG の名前と同じにする
// （知らない名前は書き込みで拒否される）。種類（type）ごとの書き方は FIELD_TYPES を見る。
const terp = window.terp;

const ICONS = {
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" />',
  agents: '<rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 4v4M9 13v2M15 13v2M2 14h2M20 14h2" />',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />',
  advanced: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />',
};

// ctx.agents() は起動できるもの、ctx.registry() は未導入・非表示を含む一覧を返す
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
      { key: 'agents', type: 'registry' },
    ],
  },
  {
    id: 'notifications',
    label: '通知',
    fields: [
      // 設定ファイルに書いていない値は、DEFAULT_CONFIG と同じ既定（default）で出す
      { key: 'notifications', label: '通知する', type: 'toggle', default: true, help: '切ると下の4項目は変更できない' },
      { key: 'notifyAgentDone', label: '応答が終わったとき', type: 'toggle', default: true, disabled: (v) => v.notifications === false },
      { key: 'notifyBell', label: 'ベルが鳴ったとき', type: 'toggle', default: true, disabled: (v) => v.notifications === false },
      { key: 'notifyWhenVisible', label: '表示中のターミナルも知らせる', type: 'toggle', disabled: (v) => v.notifications === false },
      { key: 'notifySound', label: '音を鳴らす', type: 'toggle', default: true, disabled: (v) => v.notifications === false },
      {
        type: 'action', label: '試しに通知する',
        help: 'macOS の「システム設定 → 通知」で terp の通知を許可していないと出ない',
        run: () => terp.testNotification(),
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
        help: 'この画面に無い設定は、設定ファイルに書く',
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
let sectionRenderSerial = 0;
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
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      closeSettings();
    }
  });
}

export function isSettingsOpen() {
  return !overlay.hidden;
}

export function applySettingsConfig(config) {
  for (const field of SECTIONS.flatMap((s) => s.fields)) {
    if (field.type !== 'toggle' || typeof config[field.key] !== 'boolean') continue;
    values[field.key] = config[field.key];
    const input = document.getElementById(`setting-${field.key}`);
    if (input) input.checked = config[field.key];
  }
  refreshDisabledFields();
}

function refreshDisabledFields() {
  for (const field of SECTIONS.flatMap((s) => s.fields)) {
    if (!field.disabled) continue;
    const input = document.getElementById(`setting-${field.key}`);
    if (input) input.disabled = field.disabled(values);
  }
}

export async function openSettings(sectionId) {
  const wasOpen = isSettingsOpen();
  if (sectionId) current = sectionId;
  flushRegistry();
  await registrySaveQueue;
  const res = await terp.rawConfig();
  values = res.ok ? res.value : {};
  themeColorCache.clear();
  if (!wasOpen) {
    registrySession++;
    registryStatuses = null;
    registryChecking = false;
    expandedAgents.clear();
  }
  overlay.hidden = false;
  renderNav();
  await renderSection();
  nav.querySelector('[aria-current="true"]')?.focus();
}

export function closeSettings() {
  sectionRenderSerial++;
  flushRegistry();
  registrySession++;
  registryStatuses = null;
  registryChecking = false;
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
  refreshDisabledFields();
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
      flushRegistry();
      await registrySaveQueue;
      current = section.id;
      renderNav();
      await renderSection();
    });
    nav.append(btn);
  }
}

async function renderSection() {
  const serial = ++sectionRenderSerial;
  const section = SECTIONS.find((s) => s.id === current) || SECTIONS[0];
  flushRegistry();
  content.textContent = '';
  const title = document.createElement('h2');
  title.className = 'settings__title';
  title.textContent = section.label;
  content.append(title);
  for (const field of section.fields) {
    const row = await renderField(field);
    if (serial !== sectionRenderSerial) return;
    content.append(row);
  }
  refreshDisabledFields();
  if (section.id === 'agents') {
    renderRegistryRows();
    if (registryStatuses === null && !registryChecking) recheckRegistry();
  }
}

// 種類ごとの部品。どれも { el, } を返し、変えたら save を呼ぶ
const FIELD_TYPES = {
  theme: createThemePicker,
  registry: createAgentRegistry,
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
    select.addEventListener('change', async () => {
      await save(field.key, select.selectedOptions[0].dataset.null === 'true' ? null : select.value);
      if (field.key === 'mainAgent') updateRegistryHeadings();
    });
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
    input.checked = (value ?? field.default) === true;
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
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await field.run(ctx);
        if (res?.ok === false) showStatus(res.error, 'error');
      } catch (err) {
        showStatus(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  },
};

async function renderField(field) {
  const row = document.createElement('div');
  row.className = 'settings__field';
  const id = `setting-${field.key || field.label}`;
  const control = await FIELD_TYPES[field.type](field, values[field.key], id);
  if (field.type !== 'action' && field.type !== 'registry') {
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

const FALLBACK_AGENT_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 4v4M9 13v2M15 13v2M2 14h2M20 14h2" /></svg>';

export function agentIcon(agent) {
  const icon = agent.icon;
  if (!icon || !/^[a-z-]+\.svg$/.test(icon.file)) return FALLBACK_AGENT_ICON;
  const url = `./icons/agents/${icon.file}`;
  return icon.mode === 'mask'
    ? `<span class="agent-icon agent-icon--mask" style="mask-image:url('${url}')" aria-hidden="true"></span>`
    : `<img class="agent-icon" src="${url}" alt="" aria-hidden="true">`;
}

let registryStatuses = null;
let registryChecking = false;
let registrySession = 0;
let registrySaveQueue = Promise.resolve();
const registryCommits = new Set();
const expandedAgents = new Set();
const LOGIN_LABELS = { in: '済み', out: '未', unknown: '確かめられない', unsupported: '確かめる方法が無い' };

function flushRegistry() {
  for (const commit of registryCommits) commit();
  registryCommits.clear();
}

function registryText(label, value, placeholder, commitValue, key) {
  const wrap = element('label', 'field');
  wrap.append(element('span', 'field__label', label));
  const input = element('input', 'input');
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.spellcheck = false;
  if (key) input.dataset.agentField = key;
  let saved = input.value;
  let timer;
  const commit = () => {
    clearTimeout(timer);
    if (saved === input.value) return;
    saved = input.value;
    commitValue(input.value);
  };
  registryCommits.add(commit);
  input.addEventListener('input', () => {
    registryCommits.add(commit);
    clearTimeout(timer);
    timer = setTimeout(commit, 800);
  });
  input.addEventListener('blur', commit);
  wrap.append(input);
  return wrap;
}

function registryAction(text, action, name) {
  const button = element('button', 'btn btn--xs', text);
  button.type = 'button';
  if (name) button.dataset.action = name;
  button.addEventListener('click', action);
  return button;
}

// 複数の欄を続けて変えたときも、先の保存結果に次の変更を重ねる
function changeRegistry(transform, redraw = true) {
  registrySaveQueue = registrySaveQueue.then(async () => {
    const configured = new Map();
    for (const item of Array.isArray(values.agents) ? values.agents : []) {
      if (item?.command) configured.set(item.command, { ...configured.get(item.command), ...item });
    }
    const next = transform([...configured.values()]);
    if (!await save('agents', next)) return;
    await ctx.refreshAgents();
    if (isSettingsOpen() && current === 'agents') {
      updateMainAgentChoices();
      if (redraw) renderRegistryRows();
      else updateRegistryHeadings();
    }
  }).catch(() => showStatus('保存できない。設定ファイルを確認する', 'error'));
  return registrySaveQueue;
}

function patchAgent(command, key, value, redraw = false) {
  if (key === 'path' && registryStatuses) registryStatuses = registryStatuses.filter((s) => s.command !== command);
  return changeRegistry((list) => {
    const next = list.map((a) => ({ ...a }));
    let item = next.find((a) => a.command === command);
    if (!item) next.push(item = { command });
    if (value === undefined) delete item[key];
    else item[key] = value;
    return next;
  }, redraw);
}

function effectiveMainAgent() {
  const list = ctx.registry().filter((a) => a.found && !a.hidden);
  return list.find((a) => a.command === values.mainAgent || a.command.split('/').pop() === values.mainAgent) || list[0];
}

function updateMainAgentChoices() {
  const select = document.getElementById('setting-mainAgent');
  if (!select) return;
  select.textContent = '';
  select.append(new Option('見つかった最初のもの', ''));
  select.options[0].dataset.null = 'true';
  for (const a of ctx.registry().filter((a) => a.found && !a.hidden)) select.append(new Option(a.label, a.command));
  if (values.mainAgent && ![...select.options].some((o) => o.value === values.mainAgent)) {
    select.append(new Option(`${values.mainAgent}（見つからない／非表示）`, values.mainAgent));
  }
  select.value = values.mainAgent || '';
}

function updateRegistryHeadings() {
  for (const row of content.querySelectorAll('.agent-registry__row')) {
    const agent = ctx.registry().find((a) => a.command === row.dataset.command);
    if (!agent) continue;
    row.querySelector('.agent-registry__name').textContent = agent.label;
    row.querySelector('.agent-registry__main').hidden = effectiveMainAgent()?.command !== agent.command;
    row.querySelector('[data-action="main"]').disabled = !agent.found || agent.hidden;
    row.querySelector('.agent-registry__path').textContent = `見つかった場所: ${agent.path || '見つからない'}`;
  }
  updateRegistryStatuses();
}

function updateRegistryStatuses() {
  const refresh = document.getElementById('agents-recheck');
  if (refresh) {
    refresh.textContent = registryChecking ? '確かめ中…' : '確かめ直す';
    refresh.disabled = registryChecking;
  }
  for (const row of content.querySelectorAll('.agent-registry__row')) {
    const agent = ctx.registry().find((a) => a.command === row.dataset.command);
    if (!agent) continue;
    const state = registryStatuses?.find((s) => s.command === agent.command);
    row.querySelector('.agent-registry__installed').textContent = agent.found
      ? `入っている${state?.version ? ` · ${state.version}` : ''}` : '見つからない';
    row.querySelector('.agent-registry__login').textContent = `ログイン: ${registryChecking ? '確かめ中…' : LOGIN_LABELS[state?.login || (['claude', 'codex'].includes(agent.command.split('/').pop()) ? 'unknown' : 'unsupported')]}${!registryChecking && state?.method ? `（${state.method}）` : ''}`;
  }
}

async function recheckRegistry() {
  if (registryChecking) return;
  const session = registrySession;
  registryChecking = true;
  updateRegistryStatuses();
  try {
    await ctx.refreshAgents();
    if (session !== registrySession) return;
    updateMainAgentChoices();
    updateRegistryHeadings();
    const res = await terp.agentStatus();
    if (session !== registrySession) return;
    registryStatuses = res.ok ? res.value : [];
    if (!res.ok) showStatus('状態を確かめられない。確かめ直すを押して再試行', 'error');
  } catch {
    if (session === registrySession) {
      registryStatuses = [];
      showStatus('状態を確かめられない。確かめ直すを押して再試行', 'error');
    }
  } finally {
    if (session === registrySession) {
      registryChecking = false;
      updateRegistryStatuses();
    }
  }
}

function agentEnvironmentEditor(agent, raw) {
  const wrap = element('div', 'agent-registry__env');
  wrap.append(element('h3', 'settings__label', '環境変数'));
  const rows = element('div');
  const commitEnv = () => {
    const pairs = [...rows.children].map((row) => [...row.querySelectorAll('input')].map((input) => input.value));
    if (pairs.some(([key, value]) => (!key && value) || (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))) {
      showStatus('環境変数の名前は半角英数字と _ を使い、数字で始めない', 'error');
      return;
    }
    const filled = pairs.filter(([key]) => key);
    if (new Set(filled.map(([key]) => key)).size !== filled.length) {
      showStatus('環境変数の名前が重複している', 'error');
      return;
    }
    patchAgent(agent.command, 'env', filled.length ? Object.fromEntries(filled) : undefined);
  };
  const addRow = (key = '', value = '') => {
    const row = element('div', 'agent-registry__env-row');
    row.append(registryText('名前', key, 'EXAMPLE_NAME', commitEnv, 'env-name'), registryText('値', value, '', commitEnv, 'env-value'),
      registryAction('消す', () => { row.remove(); commitEnv(); }, 'env-remove'));
    rows.append(row);
  };
  Object.entries(raw.env || {}).forEach(([key, value]) => addRow(key, value));
  wrap.append(rows, registryAction('環境変数を足す', () => addRow(), 'env-add'));
  return wrap;
}

function confirmAgentRemoval(agent) {
  const dialog = element('dialog', 'dialog');
  dialog.id = 'agent-remove-dialog';
  const body = element('div', 'dialog__body');
  const title = element('h2', 'dialog__title', 'エージェントを削除');
  title.id = 'agent-remove-title';
  dialog.setAttribute('aria-labelledby', title.id);
  body.append(title, element('p', 'dialog__note', `${agent.label} の登録と起動設定を削除する`));
  const actions = element('div', 'dialog__actions');
  const cancel = registryAction('やめる', () => dialog.close());
  actions.append(cancel, registryAction('削除', async () => {
    flushRegistry();
    await changeRegistry((list) => list.filter((a) => a.command !== agent.command));
    dialog.close();
  }, 'confirm-remove'));
  body.append(actions);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

function renderRegistryRows() {
  const host = document.getElementById('agent-registry-rows');
  if (!host) return;
  flushRegistry();
  host.textContent = '';
  const agents = ctx.registry();
  agents.forEach((agent, index) => {
    const raw = (values.agents || []).find((a) => a.command === agent.command) || {};
    const row = element('div', 'agent-registry__row');
    row.dataset.command = agent.command;
    const head = element('div', 'agent-registry__head');
    const open = element('button', 'agent-registry__open');
    open.type = 'button';
    open.innerHTML = agentIcon(agent);
    const name = element('span', 'agent-registry__identity');
    name.append(element('strong', 'agent-registry__name', agent.label), element('span', 'settings__unit', agent.command));
    open.append(name);
    const main = element('span', 'agent-registry__main session__bypass', 'メイン');
    main.hidden = effectiveMainAgent()?.command !== agent.command;
    open.append(main);
    const state = element('div', 'agent-registry__state');
    state.setAttribute('aria-live', 'polite');
    state.append(element('span', 'agent-registry__installed'), element('span', 'agent-registry__login settings__unit'));
    const show = element('label', 'agent-registry__show');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !agent.hidden;
    checkbox.dataset.action = 'visible';
    checkbox.addEventListener('change', () => { flushRegistry(); patchAgent(agent.command, 'hidden', !checkbox.checked, true); });
    show.append(checkbox, document.createTextNode('表示する'));
    const order = element('div', 'settings__inline');
    [-1, 1].forEach((direction) => {
      const move = registryAction(direction < 0 ? '↑' : '↓', () => {
        flushRegistry();
        changeRegistry((list) => {
          const commands = ctx.registry().map((a) => a.command);
          const at = commands.indexOf(agent.command);
          [commands[at], commands[at + direction]] = [commands[at + direction], commands[at]];
          return commands.map((command) => list.find((a) => a.command === command) || { command });
        });
      }, direction < 0 ? 'up' : 'down');
      move.setAttribute('aria-label', `${agent.label} を${direction < 0 ? '上' : '下'}へ`);
      move.disabled = direction < 0 ? index === 0 : index === agents.length - 1;
      order.append(move);
    });
    head.append(open, state, show, order);
    head.addEventListener('click', (event) => {
      if (!event.target.closest('button, label, input')) open.click();
    });
    const detail = element('div', 'agent-registry__detail');
    detail.hidden = !expandedAgents.has(agent.command);
    open.setAttribute('aria-expanded', String(!detail.hidden));
    open.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden) { expandedAgents.delete(agent.command); flushRegistry(); }
      else expandedAgents.add(agent.command);
      open.setAttribute('aria-expanded', String(!detail.hidden));
    });
    for (const [key, label, placeholder] of [
      ['label', '表示名', agent.defaults.label || agent.command],
      ['path', 'コマンドの場所', '空なら PATH から探す'],
      ['args', 'いつも付ける引数', ''],
      ['bypassArgs', '確認を飛ばす引数', agent.defaults.bypassArgs],
    ]) {
      detail.append(registryText(label, raw[key], placeholder, (value) => patchAgent(agent.command, key, value.trim() || undefined), key));
    }
    detail.append(element('p', 'settings__help agent-registry__path', `見つかった場所: ${agent.path || '見つからない'}`));
    detail.append(agentEnvironmentEditor(agent, raw));
    const actions = element('div', 'settings__inline');
    const setMain = registryAction('メインにする', async () => {
      flushRegistry();
      await registrySaveQueue;
      if (await save('mainAgent', agent.command)) { updateMainAgentChoices(); updateRegistryHeadings(); }
    }, 'main');
    setMain.disabled = !agent.found || agent.hidden;
    actions.append(setMain);
    detail.append(actions);
    detail.append(registryAction(agent.known ? '既定に戻す' : '削除', () => {
      if (!agent.known) return confirmAgentRemoval(agent);
      flushRegistry();
      changeRegistry((list) => list.filter((a) => a.command !== agent.command));
    }, agent.known ? 'reset' : 'remove'));
    row.append(head, detail);
    host.append(row);
  });
  updateRegistryStatuses();
}

async function createAgentRegistry() {
  await ctx.refreshAgents();
  const wrap = element('div', 'agent-registry');
  const heading = element('div', 'agent-registry__heading');
  const refresh = registryAction('確かめ直す', recheckRegistry);
  refresh.id = 'agents-recheck';
  heading.append(element('h3', 'settings__label', '登録したエージェント'), refresh);
  const rows = element('div');
  rows.id = 'agent-registry-rows';
  const add = element('details', 'agent-registry__add');
  add.append(element('summary', '', '＋ エージェントを足す'));
  const command = registryText('コマンドの名前か絶対パス', '', '', () => {}, 'new-command');
  const label = registryText('表示名', '', '', () => {}, 'new-label');
  const error = element('p', 'dialog__error');
  error.setAttribute('role', 'alert');
  add.append(command, label, error, registryAction('追加', async () => {
    const name = command.querySelector('input').value.trim();
    const display = label.querySelector('input').value.trim();
    if (!name || !display) { error.textContent = 'コマンドと表示名を入れる'; return; }
    if (ctx.registry().some((a) => a.command === name)) { error.textContent = '同じコマンドが登録されている'; return; }
    if (/\s/.test(name) && !name.startsWith('/')) { error.textContent = 'コマンドは名前か絶対パスで指定する'; return; }
    flushRegistry();
    await changeRegistry((list) => [...list, { command: name, label: display }]);
    if ((values.agents || []).some((a) => a.command === name)) {
      command.querySelector('input').value = '';
      label.querySelector('input').value = '';
      add.open = false;
      error.textContent = '';
    }
  }, 'add'));
  wrap.append(heading, rows, add);
  // renderField の後で DOM に追加されるため、描画は呼び出し側で行う
  return wrap;
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
