// TERP_SELFTEST=<出力先> で起動すると、操作を流して画面と文字を書き出し、終了する
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 認証の自己診断は、このフォルダの偽 CLI だけを実行する
function prepareAgentFakes(outDir) {
  const dir = path.join(outDir, 'agent-fakes');
  fs.mkdirSync(dir, { recursive: true });
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  for (const name of ['claude', 'codex', 'cursor-agent', 'registry-extra', 'cr', 'acli', 'kimi']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' '${name} '"$*" >> ${quote(path.join(dir, 'calls'))}
case "$*" in
  --version) printf '%s\\n' '${name} 1.2.3' '表示しない2行目' ;;
  'auth status') printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","privateField":"表示しない認証情報"}' ;;
  'login status') printf '%s\\n' 'Logged in using ChatGPT' ;;
  *) printf 'registry-started args=%s env=%s\\n' "$*" "$TERP_REGISTRY_TEST" ;;
esac
`, { mode: 0o755 });
  }
  process.env.TERP_AGENT_STATUS_FAKE = dir;
  return dir;
}

async function runAgentRegistryTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  if (!process.env.TERP_CONFIG_DIR) throw new Error('登録の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  const previousFake = process.env.TERP_AGENT_STATUS_FAKE;
  const dir = prepareAgentFakes(outDir);
  const env = await require('./git').loginEnv();
  const previousPath = env.PATH;
  env.PATH = dir;
  const fake = path.join(dir, 'registry-extra');
  const row = (name) => `document.querySelector('.agent-registry__row[data-command="${name}"]')`;
  const wait = async (fn) => {
    for (let i = 0; i < 80; i++) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const click = async (selector) => { await js(`${selector}.click()`); };
  const field = async (name, key, value) => {
    await js(`(() => { const input = ${row(name)}.querySelector('[data-agent-field="${key}"]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur')); })()`);
    await sleep(400);
  };
  const commands = () => js(`[...document.querySelectorAll('#agents .btn--agent')].map((b) => b.dataset.command)`);
  const launchText = async () => {
    await click(`document.querySelector('#agents [data-command="registry-extra"]')`);
    await wait(() => js(`window.__terp.bufferText(window.__terp.activeId).includes('registry-started args=--always --custom-bypass env=')`));
    return js('window.__terp.bufferText(window.__terp.activeId)');
  };
  try {
    const initial = JSON.parse(original);
    initial.agents = [
      { command: 'claude', path: path.join(dir, 'claude') },
      { command: 'codex', path: path.join(dir, 'codex') },
      { command: 'cursor-agent', path: path.join(dir, 'cursor-agent') },
      ...['coderabbit', 'acli', 'kimi'].map((command) => ({ command, env: { PATH: dir } })),
      { command: 'openclaw' },
      ...require('./agents').KNOWN_AGENTS.filter((a) => !['claude', 'codex', 'cursor-agent', 'coderabbit', 'acli', 'kimi', 'openclaw'].includes(a.command))
        .map((a) => ({ command: a.command, path: path.join(dir, 'missing', a.command) })),
    ];
    initial.mainAgent = 'claude';
    initial.skipApprovals = true;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initial));
    await sleep(400);
    await js('window.__terp.refreshAgents()');
    await js("window.__terp.openSettings('agents')");
    const addedCommands = ['coderabbit', 'codebuddy', 'openclaude', 'qodercli', 'qoderclicn', 'agy', 'traecli', 'kiro-cli', 'kimi', 'vibe', 'devin', 'dsh-tui', 'muse', 'grok', 'hermes', 'cline', 'kilo', 'command-code', 'zcode', 'mimo', 'opencode2', 'cn', 'acli', 'auggie', 'autohand', 'ante', 'pi', 'omp', 'prime-agent', 'codebuff', 'freebuff', 'jcode', 'openclaw'];
    check('登録一覧に既存12種と追加33種が出る', require('./agents').KNOWN_AGENTS.length === 45 && await js(`document.querySelectorAll('.agent-registry__row').length === 45 && ${JSON.stringify(addedCommands)}.every((command) => document.querySelector('.agent-registry__row[data-command="' + command + '"]')) && ${row('aider')}.textContent.includes('未連携')`));
    const linked = `document.querySelector('[data-agent-group="linked"]')`;
    const unlinked = `document.querySelector('[data-agent-group="unlinked"]')`;
    check('見出しに連携中6件と未連携39件が出る', await js(`${linked}.querySelector('summary').textContent === '連携中 6' && ${unlinked}.querySelector('summary').textContent === '未連携 39'`));
    check('導入の有無で行が分かれる', await js(`${row('claude')}.closest('details') === ${linked} && ${row('coderabbit')}.closest('details') === ${linked} && ${row('aider')}.closest('details') === ${unlinked}`));
    check('連携中は開き未連携は初め畳まれる', await js(`${linked}.open && !${unlinked}.open`));
    await click(`${unlinked}.querySelector('summary')`);
    check('未連携の見出しを押すと開く', await js(`${unlinked}.open`));
    check('各区画は設定の配列順に並ぶ', await js(`(() => { const registry = window.__terp.registry; return [true, false].every((found) => { const group = document.querySelector('[data-agent-group="' + (found ? 'linked' : 'unlinked') + '"]'); return [...group.querySelectorAll('.agent-registry__row')].map((row) => row.dataset.command).join() === registry.filter((agent) => agent.found === found).map((agent) => agent.command).join(); }); })()`));
    check('別名だけでCodeRabbitが連携中になる', await js(`window.__terp.registry.find((a) => a.command === 'coderabbit').alias === 'cr' && ${row('coderabbit')}.textContent.includes('連携中')`));
    check('Kimiは画像でCodeRabbitは既存の代替アイコンを出す', await js(`${row('kimi')}.querySelector('img').getAttribute('src').endsWith('kimi.svg') && Boolean(${row('coderabbit')}.querySelector('svg.icon')) && !${row('coderabbit')}.querySelector('.agent-icon')`));
    check('偽 CLI の版とログイン済みが出る', await wait(() => js(`${row('claude')}.textContent.includes('claude 1.2.3') && ${row('claude')}.textContent.includes('済み（claude.ai）') && ${row('codex')}.textContent.includes('codex 1.2.3') && ${row('codex')}.textContent.includes('済み（ChatGPT）')`)));
    const launch = async (command, call, altKey = false) => {
      const before = fs.readFileSync(path.join(dir, 'calls'), 'utf8').length;
      await js(`document.querySelector('#agents [data-command="${command}"]').dispatchEvent(new MouseEvent('click', { altKey: ${altKey}, bubbles: true }))`);
      return wait(async () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').slice(before).split('\n').includes(call));
    };
    check('CodeRabbitを別名crの行で起動する', await launch('coderabbit', 'cr ') && await js(`window.__terp.bufferText(window.__terp.activeId).includes(" cr")`));
    check('Rovo Devの既定の引数と確認なしの引数を渡す', await launch('acli', 'acli rovodev run --yolo'));
    check('確認ありではRovo Devの既定の引数だけ渡す', await launch('acli', 'acli rovodev run', true));
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'registry.png'), img.toPNG()));
    await click(`${row('codex')}.querySelector('.agent-registry__open')`);
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'registry-open.png'), img.toPNG()));
    await click(`${row('codex')}.querySelector('.agent-registry__open')`);
    check('認証の生出力を表示しない', await js(`!document.getElementById('settings-content').textContent.includes('表示しない認証情報')`));
    const callsBefore = fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).length;
    await click(`${row('claude')}.querySelector('[data-action="visible"]')`);
    check('非表示にすると左のボタンから消える', await wait(async () => !(await commands()).includes('claude')));
    await click("document.getElementById('tab-new')");
    check('非表示にするとプルダウンから消える', await js(`!document.querySelector('#tab-menu [data-command="claude"]')`));
    await click("document.getElementById('tab-new')");
    await click(`${row('claude')}.querySelector('[data-action="visible"]')`);
    check('表示を戻すとボタンに戻る', await wait(async () => (await commands()).includes('claude')));
    await js(`document.querySelector('.agent-registry__add').open = true; document.querySelector('[data-agent-field="new-command"]').value = 'registry-extra'; document.querySelector('[data-agent-field="new-label"]').value = '追加のエージェント'`);
    await click(`document.querySelector('.agent-registry__add [data-action="add"]')`);
    check('追加した行が出る', await wait(() => js(`Boolean(${row('registry-extra')})`)));
    await click(`${row('registry-extra')}.querySelector('.agent-registry__open')`);
    await field('registry-extra', 'path', fake);
    check('場所の上書きで起動ボタンが出る', await wait(async () => (await commands()).includes('registry-extra')));
    check('上書きした実行ファイルを使う', await js(`window.__terp.agents.find((a) => a.command === 'registry-extra').path === ${JSON.stringify(fake)}`));
    await field('registry-extra', 'args', '--always');
    await field('registry-extra', 'bypassArgs', '--custom-bypass');
    await click(`${row('registry-extra')}.querySelector('[data-action="env-add"]')`);
    await field('registry-extra', 'env-name', 'TERP_REGISTRY_TEST');
    await field('registry-extra', 'env-value', "test value's $literal");
    const text = await launchText();
    check('確認を飛ばす引数を起動へ渡す', text.includes('registry-started args=--always --custom-bypass env='));
    check('環境変数の引用符と記号を保って起動へ渡す', text.includes("env=test value's $literal"));
    await wait(() => js(`!document.getElementById('agents-recheck').disabled`));
    await click(`${row('registry-extra')}.querySelector('[data-action="up"]')`);
    await sleep(400);
    check('並べ替えを設定へ保存する', JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).agents.at(-2).command === 'registry-extra');
    // ボタンのある Codex と順を入れ替え、未導入の行を挟む場合も確認する
    for (let i = 0; i < require('./agents').KNOWN_AGENTS.length - 2; i++) {
      await click(`${row('registry-extra')}.querySelector('[data-action="up"]')`);
      await sleep(250);
    }
    check('並べ替えが起動ボタンにも反映される', (await commands()).indexOf('registry-extra') < (await commands()).indexOf('codex'));
    await click(`${row('codex')}.querySelector('.agent-registry__open')`);
    await click(`${row('codex')}.querySelector('[data-action="main"]')`);
    check('メインのボタンとアイコンが変わる', await wait(() => js(`document.getElementById('tab-main-agent').dataset.command === 'codex' && document.querySelector('#tab-main-agent img').getAttribute('src').endsWith('codex.svg')`)));
    check('Claude の色付きアイコンを画像で出す', await js(`document.querySelector('#agents [data-command="claude"] img').getAttribute('src').endsWith('claude.svg')`));
    check('単色アイコンを mask で出す', await js(`document.querySelector('#agents [data-command="cursor-agent"] .agent-icon--mask').style.maskImage.includes('cursor-agent.svg')`));
    const calls = () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).length;
    const beforeRefresh = calls();
    fs.copyFileSync(path.join(dir, 'registry-extra'), path.join(dir, 'openclaw'));
    await click("document.getElementById('agents-recheck')");
    check('確かめ直すと CLI が再実行される', await wait(async () => calls() > beforeRefresh));
    await wait(() => js(`!document.getElementById('agents-recheck').disabled`));
    check('再確認で見つかった行が連携中へ移る', await js(`${row('openclaw')}.closest('details') === ${linked} && ${linked}.querySelector('summary').textContent === '連携中 8' && ${unlinked}.querySelector('summary').textContent === '未連携 38'`));
    check('再描画と再確認で未連携の開閉を保つ', await js(`${unlinked}.open`));
    const afterRefresh = calls();
    await click(`${row('registry-extra')}.querySelector('.agent-registry__open')`);
    await sleep(200);
    check('行の開閉では CLI を再実行しない', calls() === afterRefresh && calls() > callsBefore);
    await click(`${row('registry-extra')}.querySelector('[data-action="remove"]')`);
    check('削除前に確認する', await js(`document.getElementById('agent-remove-dialog').open`));
    await click(`document.querySelector('#agent-remove-dialog [data-action="confirm-remove"]')`);
    check('削除するとボタンから消える', await wait(async () => !(await commands()).includes('registry-extra')));
    await js(`document.getElementById('settings-close').click()`);
  } finally {
    env.PATH = previousPath;
    fs.writeFileSync(CONFIG_PATH, original);
    if (previousFake === undefined) delete process.env.TERP_AGENT_STATUS_FAKE;
    else process.env.TERP_AGENT_STATUS_FAKE = previousFake;
  }
}

// TERP_SELFTEST_SETTINGS を付けると、設定の画面（左のメニュー・各項目の保存と反映・Esc で閉じる）を確かめる
async function runSettingsTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const fakeDir = prepareAgentFakes(outDir);
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const shot = (name) => win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()));
  // 設定ファイルに画面に無い値を書いておき、画面で変えても消えないことを見る
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...saved(), agents: [{ command: 'keep-me' }, { command: 'claude', path: path.join(fakeDir, 'claude') }, { command: 'codex', path: path.join(fakeDir, 'codex') }] }, null, 2));
  await sleep(1200);

  win.webContents.send('menu', 'settings');
  await sleep(800);
  check('⌘, で設定の画面が開く', (await js(`document.getElementById('settings').hidden`)) === false);
  const navs = await js(`[...document.querySelectorAll('#settings-nav .settings__nav-item')].map((b) => b.textContent)`);
  check('左にメニューが並ぶ', navs.join() === '外観,AI エージェント,コマンド,通知,詳しい設定', navs.join());
  const themeCount = await js(`document.querySelectorAll('.theme-picker__row').length`);
  check('テーマを一覧から選べる', themeCount > 100, `${themeCount} 件`);
  await shot('1-appearance');

  await js(`[...document.querySelectorAll('.theme-picker__row')].find((row) => row.dataset.theme === 'Sakura Night').click()`);
  await sleep(1500);
  check('テーマを選ぶと設定ファイルに書く', saved().theme === 'Sakura Night', saved().theme);
  check('テーマを選ぶとすぐ反映される', (await js('window.__terp.config.chrome.accent')) === '#ff9ebb', await js('window.__terp.config.chrome.accent'));

  await js(`(() => { const s = document.getElementById('setting-fontSize'); s.value = '16'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  const id = await js('window.__terp.activeId');
  check('文字の大きさが端末に反映される', saved().fontSize === 16 && (await js(`window.__terp.sessions.get(${id}).term.options.fontSize`)) === 16);
  await js(`(() => { const s = document.getElementById('setting-fontSize'); s.value = '99'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('範囲の外の数は書かずに知らせる', saved().fontSize === 16 && (await js(`document.getElementById('settings-status').textContent`)).includes('9〜32'));

  await js(`(() => { const s = document.getElementById('setting-backgroundBlur'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('ぼかしを 0 にすると false で書く', saved().backgroundBlur === false, String(saved().backgroundBlur));

  await js(`[...document.querySelectorAll('#settings-nav .settings__nav-item')].find((b) => b.textContent === 'AI エージェント').click()`);
  await sleep(500);
  check('メニューを押すとその設定に切り替わる', (await js(`document.querySelector('.settings__title').textContent`)) === 'AI エージェント');
  await js(`document.getElementById('setting-skipApprovals').click()`);
  await sleep(1500);
  check('切り替えを押すと設定ファイルに書く', saved().skipApprovals === true);
  check('切り替えが画面のボタンに反映される', (await js(`document.getElementById('tab-main-agent').dataset.bypass`)) === 'true');
  await shot('2-agents');
  await js(`(() => { const s = document.getElementById('setting-mainAgent'); s.value = 'codex'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  check('メインのエージェントを選べる', saved().mainAgent === 'codex' && (await js(`document.getElementById('tab-main-agent').dataset.command`)) === 'codex');
  check('画面に無い設定は消さない', saved().agents?.[0]?.command === 'keep-me');

  await js(`document.getElementById('settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  check('Esc で閉じる', await js(`document.getElementById('settings').hidden`));
}

// TERP_SELFTEST_GHOSTTY は、一時フォルダの設定だけで差分・保存・端末への反映を確かめる
async function runGhosttyTest({ win, js, check }) {
  const { CONFIG_PATH, CONFIG_DIR } = require('./config');
  const temporary = fs.realpathSync(os.tmpdir()) + path.sep;
  if (!process.env.TERP_CONFIG_DIR || !fs.realpathSync(CONFIG_DIR).startsWith(temporary)) {
    throw new Error('Ghostty の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-ghostty-'));
  const previous = process.env.TERP_GHOSTTY_CONFIG;
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  const theme = 'terp-selftest-ghostty';
  const themePath = path.join(CONFIG_DIR, 'themes', theme);
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const open = async () => { win.webContents.send('menu', 'settings'); await sleep(900); };
  try {
    fs.mkdirSync(path.dirname(themePath), { recursive: true });
    fs.writeFileSync(themePath, 'background = #202020\nforeground = #eeeeee\n');
    process.env.TERP_GHOSTTY_CONFIG = path.join(dir, 'config');
    fs.writeFileSync(process.env.TERP_GHOSTTY_CONFIG, [
      '# 読み取りの確認', 'config-file = extra', 'font-size = 12',
      'font-family = "Test Mono"', `theme = light:X,dark:${theme}`,
      'window-padding-x = 4,12', 'window-padding-y = 6,14',
      'cursor-style = bar', 'cursor-style-blink = true', 'bold-color = #ffffff', 'macos-option-as-alt = true',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'extra'), [
      'font-family = "Test Fallback"', 'font-size = 19', 'minimum-contrast = 4.5',
      'background-opacity = 0.8', 'background-blur = 12', 'config-file = ?missing', 'config-file = config',
    ].join('\n'));
    fs.writeFileSync(CONFIG_PATH, '{}\n');
    await sleep(500);
    await open();
    await js(`document.getElementById('ghostty-import-open').click()`);
    await sleep(500);
    const preview = await js(`document.getElementById('ghostty-import-detail').textContent`);
    check('取り込みの差分をラベルと前後の値で表示する', preview.includes('文字の大きさ: 14 → 19') && preview.includes('余白（左右）: 10 → 8'));
    check('写さない項目に理由を表示する', preview.includes('bold-color = #ffffff — terp に無い') && preview.includes('macos-option-as-alt = true — terp は常に Meta'));
    check('読んだファイルを表示する', preview.includes(process.env.TERP_GHOSTTY_CONFIG) && preview.includes(path.join(dir, 'extra')));
    const beforeCancel = fs.readFileSync(CONFIG_PATH, 'utf8');
    await js(`document.getElementById('ghostty-import-cancel').click()`);
    await sleep(250);
    check('やめるでは保存しない', fs.readFileSync(CONFIG_PATH, 'utf8') === beforeCancel && !(await js(`!!document.getElementById('ghostty-import-dialog')`)));
    await js(`document.getElementById('ghostty-import-open').click()`);
    await sleep(400);
    await js(`document.getElementById('ghostty-import-apply').click()`);
    await sleep(1200);
    const values = saved();
    check('取り込んだ値を設定ファイルに書く', values.theme === theme && values.fontSize === 19 && values.paddingX === 8 && values.paddingY === 10 && values.minimumContrast === 4.5 && values.cursorStyle === 'bar' && values.cursorBlink === true && values.backgroundOpacity === 0.8 && values.backgroundBlur === 12);
    check('フォントの順と日本語の代替フォントを保つ', values.fontFamily === '"Test Mono", "Test Fallback", Menlo, "Hiragino Sans", monospace');
    check('端末に文字・コントラスト・カーソルを反映する', await js(`(() => {
      const terminals = [...window.__terp.sessions.values()].map((s) => s.term.options);
      return terminals.length > 0 && terminals.every((o) => o.fontSize === 19 && o.minimumContrastRatio === 4.5 && o.cursorStyle === 'bar' && o.cursorBlink === true);
    })()`));
    check('余白の CSS 変数を反映する', await js(`(() => {
      const style = getComputedStyle(document.documentElement);
      return style.getPropertyValue('--term-padding-x').trim() === '8px' && style.getPropertyValue('--term-padding-y').trim() === '10px';
    })()`));
    check('設定の欄を描き直す', await js(`document.getElementById('setting-fontSize').value === '19' && document.getElementById('setting-cursorStyle').value === 'bar'`));
    await js(`document.getElementById('ghostty-import-open').click()`);
    await sleep(400);
    check('取り込み直後は差分がなく取り込めない', await js(`document.getElementById('ghostty-import-detail').textContent.includes('変わる項目はない') && document.getElementById('ghostty-import-apply').disabled`));
    await js(`document.getElementById('ghostty-import-cancel').click()`);
    await js(`document.getElementById('settings-close').click()`);
    process.env.TERP_GHOSTTY_CONFIG = path.join(dir, 'missing');
    await open();
    check('設定が見つからなければボタンを押せず理由を表示する', await js(`document.getElementById('ghostty-import-open').disabled && document.getElementById('ghostty-import-status').textContent === 'Ghostty の設定が見つからない'`));
    await js(`document.getElementById('settings-close').click()`);
  } finally {
    if (previous === undefined) delete process.env.TERP_GHOSTTY_CONFIG;
    else process.env.TERP_GHOSTTY_CONFIG = previous;
    fs.writeFileSync(CONFIG_PATH, original);
    fs.rmSync(themePath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_AGENTSTATUS は、名前を実際に拾える偽 CLI でエージェントの表示と移動を確かめる。
async function runAgentStatusTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  if (!process.env.TERP_CONFIG_DIR) throw new Error('状態の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-agent-status-'));
  const fake = path.join(dir, 'claude');
  const script = path.join(dir, 'status.js');
  // 本体は前面のプログラムの名前を実行ファイルの実体から拾うため、リンクでは名前が変わらない。
  // macOS は写したシステムのプログラム（/bin/sh など）を起動時に止めるため、node の実行ファイルを写して使う
  const node = require('child_process').execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
  fs.copyFileSync(node, fake);
  fs.chmodSync(fake, 0o755);
  const ids = [];
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(script, `require('child_process').execSync('stty -echo', { stdio: 'inherit' });
const out = (text) => process.stdout.write(text);
out('agent-status-ready\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (command) => {
  if (command === 'work') out('\\x1b]0;⠂ 状態の確認\\x07');
  if (command === 'done') out('\\x1b]0;✳ 状態の確認\\x07');
  if (command === 'permission') out('\\x1b]9;Claude needs your permission to use Bash\\x07');
  if (command === 'approval') out('\\x1b]777;notify;Claude;承認待ち\\x07');
  if (command === 'echo') out('input-echo\\n');
  if (command === 'output') setTimeout(() => {
    let n = 0;
    const timer = setInterval(() => { out('agent-output\\n'); if (++n === 8) clearInterval(timer); }, 250);
  }, 600);
  if (command === 'blip') setTimeout(() => out('agent-blip\\n'), 800);
});
`);
  const wait = async (fn) => {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return true;
      await sleep(50);
    }
    throw new Error('エージェントの状態の自己診断で応答を待ち切れなかった');
  };
  const settings = async (patch) => {
    const result = await js(`window.terp.updateConfig(${JSON.stringify(patch)})`);
    if (!result.ok) throw new Error(result.error);
    await wait(() => js(`Object.entries(${JSON.stringify(patch)}).every(([key, value]) => window.__terp.config[key] === value)`));
  };
  const state = (id) => js(`window.__terp.sessions.get(${id}).li.dataset.agentState`);
  const input = (id, command) => js(`window.__terp.sessions.get(${id}).term.input(${JSON.stringify(command + '\r')}, true)`);
  const tab = (id) => `document.querySelector('.tab[data-key="t:${id}"]')`;
  const row = (id) => `window.__terp.sessions.get(${id}).li`;
  const badge = () => require('./main').__test.dockBadge;
  const colorMatches = (id, property, variable) => js(`(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(${variable})';
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(${row(id)}.querySelector('.session__dot'))[${JSON.stringify(property)}] === expected;
  })()`);
  try {
    await settings({ notifications: false, dockBadge: true });
    await js('window.__terp.setFocusForTest(true)');
    const root = path.resolve(__dirname, '..');
    const added = await js(`window.__terp.addProject(${JSON.stringify(root)})`);
    if (!added.ok) throw new Error(added.error);
    for (let i = 0; i < 2; i++) {
      const id = await js(`window.__terp.open(${JSON.stringify(root)})`);
      ids.push(id);
      await js(`window.terp.write(${id}, ${JSON.stringify(quote(fake) + ' ' + quote(script) + '\r')})`);
      await wait(() => js(`window.__terp.bufferText(${id}).includes('agent-status-ready') && window.__terp.sessions.get(${id}).program === 'claude'`));
    }
    const [first, second] = ids;
    check('偽 CLI の名前を本体が claude として拾う', await js(`${JSON.stringify(ids)}.every((id) => window.__terp.sessions.get(id).program === 'claude')`));
    const shell = await js(`window.__terp.open(${JSON.stringify(root)})`);
    ids.push(shell);
    await sleep(2300);
    await input(first, 'work');
    await wait(async () => (await state(first)) === 'working');
    const before = await js(`${row(first)}.querySelector('.session__dot').title`);
    await sleep(1200);
    const after = await js(`${row(first)}.querySelector('.session__dot').title`);
    check('考え中の経過は印の説明に出て秒が進む', /^考え中 0:0\d$/.test(before) && before !== after);
    check('一覧とタブに強調色の輪を出す', await colorMatches(first, 'borderTopColor', '--color-accent') && await js(`(() => {
      const dot = ${row(first)}.querySelector('.session__dot');
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      return getComputedStyle(dot).animationName === (reduced ? 'agent-pulse' : 'agent-spin') && ${tab(first)}.dataset.agentState === 'working';
    })()`));
    await input(first, 'permission');
    await wait(async () => (await state(first)) === 'waiting');
    check('許可待ちは黄色の ! で出す', await colorMatches(first, 'backgroundColor', '--history-yellow') && await js(`${row(first)}.querySelector('.session__dot').textContent === '!' && ${row(first)}.querySelector('.session__dot').title === '許可待ち' && ${tab(first)}.querySelector('.tab__dot').textContent === '!'`));
    check('通知を切っていても Dock は許可待ちを数える', await wait(() => badge() === '1'));
    await input(first, 'echo');
    await wait(async () => (await state(first)) === 'idle');
    check('打鍵で許可待ちを下ろし、直後の出力は考え中にしない', await state(first) === 'idle');
    // 題名で知らせたことの無い端末だけ、続く出力で考え中にする
    await input(second, 'output');
    check('題名を出さない端末は続く出力で考え中にする', await wait(async () => (await state(second)) === 'working'));
    await wait(async () => (await state(second)) === 'idle');
    await sleep(2300);
    await input(first, 'work');
    await wait(async () => (await state(first)) === 'working');
    await input(first, 'done');
    await wait(async () => (await state(first)) === 'done');
    await input(first, 'blip');
    await sleep(1500);
    check('終わった後の1回の出力では考え中に戻らない', await state(first) === 'done');
    check('見ていない応答の終わりは一覧とタブが緑になる', await colorMatches(first, 'backgroundColor', '--history-green') && await js(`${tab(first)}.dataset.agentState === 'done' && ${row(first)}.querySelector('.session__dot').title.startsWith('終わった · ')`));
    await input(second, 'approval');
    await wait(async () => (await state(second)) === 'waiting');
    // 一覧は 500ms ごとに描き直すため、描き直しを待ってから撮る
    await sleep(700);
    fs.writeFileSync(path.join(outDir, 'agent-status.png'), (await win.webContents.capturePage()).toPNG());
    check('Dock は許可待ちと終わったを合計する', await wait(() => badge() === '2'));
    const workButton = `document.querySelector('.work[data-path="' + CSS.escape(window.__terp.workOf(${first})) + '"] .work__status')`;
    check('作業の行は終わったより許可待ちを優先する', await js(`${workButton}.dataset.agentState === 'waiting'`));
    await input(first, 'permission');
    await wait(async () => (await state(first)) === 'waiting');
    check('作業の行は同じ状態の件数を添える', await js(`${workButton}.querySelector('.work__status-count').textContent === '2'`));
    await js(`${workButton}.click()`);
    check('作業の印を押すと先頭の要対応を表示する', await js(`window.__terp.activeId === ${first}`));
    const { Menu } = require('electron');
    const move = Menu.getApplicationMenu().items.find((item) => item.label === '移動');
    const next = move.submenu.items.find((item) => item.label === '次の要対応');
    next.click();
    check('次の要対応は一覧の次の許可待ちへ移る', await wait(() => js(`window.__terp.activeId === ${second}`)));
    next.click();
    check('次の要対応は末尾から先頭へ戻る', await wait(() => js(`window.__terp.activeId === ${first}`)));
    await input(first, 'echo');
    await input(second, 'echo');
    await wait(async () => (await state(second)) === 'idle');
    await js(`window.__terp.activate(${shell})`);
    await input(first, 'work');
    await wait(async () => (await state(first)) === 'working');
    await input(first, 'done');
    await wait(async () => (await state(first)) === 'done');
    await js(`window.__terp.activate(${first})`);
    check('終わった端末を表示すると待機へ戻る', await state(first) === 'idle');
    await input(second, 'permission');
    await wait(async () => (await state(second)) === 'waiting');
    await js("window.__terp.openSettings('notifications')");
    check('通知が無効でも Dock の設定は触れる', await js("!document.getElementById('setting-dockBadge').disabled"));
    await js("document.getElementById('setting-dockBadge').click()");
    check('Dock に数を出すを切ると消える', await wait(() => badge() === ''));
    await js("document.getElementById('setting-dockBadge').click()");
    check('Dock を戻すと現在の件数を出す', await wait(() => badge() === '1'));
    await js(`document.getElementById('settings-close').click(); window.__terp.activate(${shell})`);
    await js(`window.terp.write(${shell}, "printf 'shell-status-test\\n'\\r")`);
    check('シェルの印は従来の出力中を保つ', await wait(() => js(`!${row(shell)}.hasAttribute('data-agent-state') && ${row(shell)}.dataset.state === 'busy'`)));
    await sleep(2300);
    check('シェルの印は出力後に従来の待機へ戻る', await js(`${row(shell)}.dataset.state === 'idle'`));
  } finally {
    for (const id of ids) await js(`window.terp.kill(${id})`).catch(() => {});
    await js('window.__terp.setFocusForTest(null)').catch(() => {});
    fs.writeFileSync(CONFIG_PATH, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_NOTIFY は実通知を出さず、端末の出力・設定・通知を押した後の移動を確かめる
async function runNotifyTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const notify = require('./notify');
  const agentreply = require('./agentreply');
  if (!process.env.TERP_CONFIG_DIR) throw new Error('通知の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  const previousFake = process.env.TERP_REPLY_FAKE_DIR;
  const fakeDir = path.join(outDir, 'reply-fakes');
  const claudeDir = path.join(fakeDir, 'projects', 'test-project');
  fs.mkdirSync(claudeDir, { recursive: true });
  process.env.TERP_REPLY_FAKE_DIR = fakeDir;
  let delayedWrite;
  const wait = async (fn) => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return true;
      await sleep(50);
    }
    throw new Error('通知の自己診断で応答を待ち切れなかった');
  };
  const settings = async (patch) => {
    const res = await js(`window.terp.updateConfig(${JSON.stringify(patch)})`);
    if (!res.ok) throw new Error(res.error);
    await wait(() => js(`Object.entries(${JSON.stringify(patch)}).every(([key, value]) => window.__terp.config[key] === value)`));
  };
  const records = notify.__test.shown;
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  let serial = 0;
  const emit = async (id, sequence) => {
    const marker = `marker-${++serial}`;
    const command = `printf '%b' ${quote(sequence)}; printf '\\nnotify-%s\\n' ${quote(marker)}\r`;
    await js(`window.terp.write(${id}, ${JSON.stringify(command)})`);
    await wait(() => js(`window.__terp.bufferText(${id}).includes(${JSON.stringify('notify-' + marker)})`));
    await sleep(100);
  };
  const done = (id) => emit(id, '\\033]0;⠂ 作業\\007\\033]0;✳ 作業\\007');
  const bell = (id) => emit(id, '\\007');
  const cooldown = () => sleep(3100);
  try {
    await settings({ notifications: true, notifyAgentDone: true, notifyBell: true, notifyWhenVisible: false, notifySound: true, notifyMessage: false });
    await js('window.__terp.setFocusForTest(false)');
    const root = path.resolve(__dirname, '..');
    const added = await js(`window.__terp.addProject(${JSON.stringify(root)})`);
    if (!added.ok) throw new Error(added.error);
    const id = await js(`window.__terp.open(${JSON.stringify(root)})`);
    await js(`window.__terp.rename(${id}, '通知の端末')`);
    const start = records.length;
    await done(id);
    check('題名の変化でセッションの表示名と作業名を通知する', records.length === start + 1 && records.at(-1).title === '通知の端末 · ' + records.at(-1).body.slice('応答が終わった · '.length) && records.at(-1).body.startsWith('応答が終わった · ') && records.at(-1).body.includes(' / '));
    check('焦点が無ければ表示中でも一覧の通知の印を付ける', await js(`window.__terp.sessions.get(${id}).notify`));
    await emit(id, '\\033]9;すぐ後の通知\\007');
    check('題名のすぐ後の OSC 9 を3秒以内ならまとめる', records.length === start + 1);
    await cooldown();
    await emit(id, '\\033]9;Claude is waiting for your input\\007');
    check('3秒後の OSC 9 の本文を使う', records.length === start + 2 && records.at(-1).body.startsWith('Claude is waiting for your input · '));
    await cooldown();
    let before = records.length;
    await emit(id, '\\033]777;notify;題;本文だけ\\007');
    check('OSC 777 は題を除いて本文だけを使う', records.length === before + 1 && records.at(-1).body.startsWith('本文だけ · '));
    await cooldown();
    await js(`window.__terp.activate(${id})`);
    before = records.length;
    await emit(id, '\\033]9;4;1;50\\007');
    check('OSC 9 の進み具合は通知にも一覧の印にもしない', records.length === before && !(await js(`window.__terp.sessions.get(${id}).notify`)));
    await bell(id);
    check('ベルの既定の本文を使う', records.length === before + 1 && records.at(-1).body.startsWith('ベルが鳴った · '));

    await cooldown();
    await settings({ notifyBell: false });
    before = records.length;
    await bell(id);
    check('ベルだけを切れる', records.length === before);
    await done(id);
    check('ベルを切っても応答の終わりは通知する', records.length === before + 1);
    await cooldown();
    await settings({ notifyAgentDone: false, notifyBell: true });
    before = records.length;
    await done(id);
    check('応答の終わりだけを切れる', records.length === before);
    await bell(id);
    check('応答の終わりを切ってもベルは通知する', records.length === before + 1);

    await cooldown();
    await settings({ notifyAgentDone: true });
    await js(`window.__terp.activate(${id}); window.__terp.setFocusForTest(true)`);
    before = records.length;
    await done(id);
    check('焦点があり表示中なら通知も一覧の印も付けない', records.length === before && !(await js(`window.__terp.sessions.get(${id}).notify`)));
    const sourcePane = await js('window.__terp.activePaneId');
    // 非アクティブの枠に見えている端末も、表示中として扱う
    win.webContents.send('menu', 'split-right');
    await wait(() => js('window.__terp.layout().type === "split"'));
    const other = await js('window.__terp.activeId');
    await done(id);
    check('焦点があり別の枠に表示中でも OS 通知は出さない', records.length === before);
    check('別の枠の端末には従来どおり一覧の通知の印を付ける', await js(`window.__terp.sessions.get(${id}).notify`));
    await settings({ notifyWhenVisible: true });
    await done(id);
    check('表示中も知らせる設定をすぐ反映する', records.length === before + 1);
    await cooldown();
    await settings({ notifyWhenVisible: false });
    await js('window.__terp.setFocusForTest(false)');
    before = records.length;
    await done(id);
    check('焦点が無ければ別の枠に表示中でも通知する', records.length === before + 1);

    await cooldown();
    await js("window.__terp.openSettings('notifications')");
    await js("document.getElementById('setting-notifications').click()");
    await wait(() => js('window.__terp.config.notifications === false'));
    const dependents = ['notifyAgentDone', 'notifyBell', 'notifyWhenVisible', 'notifySound', 'notifyMessage'];
    check('通知を切ると5項目が触れなくなる', await js(`${JSON.stringify(dependents)}.every((key) => document.getElementById('setting-' + key).disabled)`));
    await js(`window.__terp.activate(${id}); window.__terp.activate(${other})`);
    before = records.length;
    await done(id);
    await bell(id);
    check('通知を切ると応答の終わりもベルも出さない', records.length === before);
    check('通知を切っても一覧の印は付ける', await js(`window.__terp.sessions.get(${id}).notify`));
    // 手で設定を変えた場合も、開いている設定画面へ反映する
    await settings({ notifySound: false });
    await js("[...document.querySelectorAll('#settings-content button')].find((b) => b.textContent === '試しに通知する').click()");
    await wait(() => records.length === before + 1);
    check('通知を切っていても試用は音なしで出る', records.at(-1).title === 'terp' && records.at(-1).body === '通知の試し' && records.at(-1).silent === true);
    await js("document.getElementById('setting-notifications').click()");
    await wait(() => js('window.__terp.config.notifications === true'));
    check('通知を戻すと5項目が触れる', await js(`${JSON.stringify(dependents)}.every((key) => !document.getElementById('setting-' + key).disabled)`));
    await js("document.getElementById('settings-close').click()");

    // 枠から外し、作業の外の端末を表示してから通知を押す
    const loose = await js(`window.__terp.open(${JSON.stringify(outDir)})`);
    await js(`window.__terp.dropTab('t:${other}', ${JSON.stringify(sourcePane)}, 'center')`);
    await js(`window.__terp.activate(${loose})`);
    before = records.length;
    await done(id);
    check('通知の音の変更を通常の通知にも反映する', records.length === before + 1 && records.at(-1).silent === true);
    notify.__test.click(start);
    await sleep(100);
    check('置き換えた古い通知は押せない', await js(`window.__terp.activeKey === 't:${loose}'`));
    notify.__test.click(records.length - 1);
    await wait(() => js(`window.__terp.activeKey === 't:${id}'`));
    check('通知を押すと別の作業から元のターミナルへ移る', await js(`window.__terp.visibleKeys().includes('t:${id}') && !window.__terp.visibleKeys().includes('t:${loose}')`));
    check('通知を押して表示すると一覧の印が消える', !(await js(`window.__terp.sessions.get(${id}).notify`)));
    check('自己診断の通知を押しても窓は焦点を奪わない', !win.isFocused());

    const claudeFile = path.join(claudeDir, 'notify-session.jsonl');
    const codexFile = path.join(fakeDir, 'rollout-notify.jsonl');
    const user = (text) => ({ type: 'user', message: { content: text } });
    const assistant = (content) => ({ type: 'assistant', message: { content } });
    const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    writeRows(claudeFile, [
      user('前の質問'), assistant([{ type: 'text', text: '前の返答' }]),
      user('通知の確認'),
      assistant([{ type: 'thinking', thinking: '表示しない' }, { type: 'text', text: '## **修正した**' }, { type: 'tool_use', name: 'Read' }]),
      user([{ type: 'tool_result', content: '表示しない' }]),
      { ...assistant([{ type: 'text', text: '表示しない別の返答' }]), isSidechain: true },
      assistant([{ type: 'text', text: '- [確認](https://example.com)も完了' }]),
    ]);
    agentreply.__test.setLookup(() => ({ kind: 'claude', sessionId: 'notify-session' }));
    await settings({ notifyMessage: true });
    const replyDone = async () => {
      await cooldown();
      const count = records.length;
      const startedAt = Date.now();
      await done(id);
      await wait(() => records.length === count + 1);
      return Date.now() - startedAt;
    };
    await replyDone();
    check('Claude の締めの返答（最後の道具の結果より後の text）だけを使う', records.at(-1).body === '確認も完了');
    check('返答を使う通知の題に表示名と作業名を入れる', records.at(-1).title.startsWith('通知の端末 · ') && records.at(-1).title.includes(' / '));

    const complete = (text) => ({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });
    writeRows(codexFile, [complete('古い返答'), complete('最後の __返答__')]);
    agentreply.__test.setLookup(() => ({ kind: 'codex', file: codexFile }));
    await replyDone();
    check('Codex の最後の task_complete の返答を使う', records.at(-1).body === '最後の 返答');

    await cooldown();
    const delayedCount = records.length;
    await done(id);
    delayedWrite = setTimeout(() => writeRows(codexFile, [complete('1秒後の新しい返答')]), 1000);
    await wait(() => records.length === delayedCount + 1);
    check('通知の出来事の1秒後の記録を待って新しい返答を使う', records.at(-1).body === '1秒後の新しい返答');
    const timeoutElapsed = await replyDone();
    check('2秒で新しい返答が無ければ従来の本文を使う', records.at(-1).body.startsWith('応答が終わった · ') && timeoutElapsed >= 1900 && timeoutElapsed < 3000);

    writeRows(codexFile, [complete('あ'.repeat(301))]);
    await replyDone();
    check('300字を超える返答は300字と省略記号にする', records.at(-1).body === 'あ'.repeat(300) + '…');
    await settings({ notifyMessage: false });
    await replyDone();
    check('返答の文を出す設定を切ると従来の本文を使う', records.at(-1).body.startsWith('応答が終わった · '));
    agentreply.__test.setLookup(null);

    await cooldown();
    await bell(id);
    const last = records.length - 1;
    await js(`window.__terp.closeKey('t:${id}')`);
    await wait(() => js(`!window.__terp.sessions.has(${id})`));
    await js(`window.__terp.activate(${loose})`);
    notify.__test.click(last);
    await sleep(100);
    check('端末を閉じるとその通知も閉じる', await js(`window.__terp.activeKey === 't:${loose}'`));
    notify.show({ id, title: '終了した端末', body: '通知の試し' });
    notify.__test.click(records.length - 1);
    await sleep(100);
    check('通知先が無くてもタブを変えない', await js(`window.__terp.activeKey === 't:${loose}'`));
  } finally {
    clearTimeout(delayedWrite);
    agentreply.__test.setLookup(null);
    if (previousFake === undefined) delete process.env.TERP_REPLY_FAKE_DIR;
    else process.env.TERP_REPLY_FAKE_DIR = previousFake;
    await js('window.__terp.setFocusForTest(null)');
    await js("document.getElementById('settings-close').click()");
    fs.writeFileSync(CONFIG_PATH, original);
  }
}

// TERP_SELFTEST_THEMEAI は、本物の claude を呼ばずにテーマの選択・作成・保存を確かめる
async function runThemeAiTest({ win, js, check, outDir }) {
  const config = require('./config');
  if (!process.env.TERP_CONFIG_DIR) throw new Error('テーマの自己診断には一時フォルダの TERP_CONFIG_DIR が必要です');
  const saved = () => JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
  // 作り直しを含めると偽の claude を2回呼ぶため、他の試しを続けて流して忙しいときも足りるよう 15 秒まで待つ
  const wait = async (code) => {
    for (let n = 0; n < 300; n++) {
      if (await js(code)) return true;
      await sleep(50);
    }
    return false;
  };
  const stamp = Date.now();
  const name = `ThemeAI ${stamp}`;
  const theme = {
    name, background: '#101820', foreground: '#f0f4f8', cursor: '#58c4ff', cursorText: '#101820',
    selectionBackground: '#345678', selectionForeground: '#ffffff',
    palette: ['#202830', '#ee6688', '#88cc88', '#eedd88', '#5599ee', '#bb88dd', '#66cccc', '#dddddd',
      '#667788', '#ff88aa', '#aaffaa', '#ffeeaa', '#88bbff', '#ddaaff', '#88eeee', '#ffffff'],
  };
  const fixtureA = `Preview A ${stamp}`;
  const fixtureB = `Preview B ${stamp}`;
  const dir = path.join(config.CONFIG_DIR, 'themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fixtureA), 'background = #101820\nforeground = #f0f4f8\ncursor-color = #58c4ff\n');
  fs.writeFileSync(path.join(dir, fixtureB), 'background = #f0f4f8\nforeground = #101820\ncursor-color = #345678\n');
  const fake = path.join(outDir, 'fake-theme-claude');
  const countFile = `${fake}.count`;
  const modeFile = `${fake}.mode`;
  const promptFile = `${fake}.prompt`;
  const shellQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const envelope = (value) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(value) + '\n```' });
  fs.writeFileSync(fake, `#!/bin/sh
count_file=${shellQuote(countFile)}
mode_file=${shellQuote(modeFile)}
n=0
if [ -f "$count_file" ]; then n=$(cat "$count_file"); fi
n=$((n + 1))
printf '%s' "$n" > "$count_file"
printf '%s' "$2" > ${shellQuote(promptFile)}
mode=good
if [ -f "$mode_file" ]; then mode=$(cat "$mode_file"); fi
if [ "$mode" = slow ]; then sleep 1; fi
if [ "$mode" = low ] || { [ "$mode" = recover ] && [ "$n" -eq 1 ]; }; then
cat <<'THEME_JSON'
${envelope({ ...theme, foreground: theme.background })}
THEME_JSON
else
cat <<'THEME_JSON'
${envelope(theme)}
THEME_JSON
fi
`, { mode: 0o755 });
  const previousBin = process.env.TERP_CLAUDE_BIN;
  process.env.TERP_CLAUDE_BIN = fake;
  const openAi = async () => {
    await js(`document.getElementById('theme-ai-open').click()`);
    return wait(`document.getElementById('theme-ai-dialog').open`);
  };
  const createAi = async () => {
    await js(`document.getElementById('theme-ai-create').click()`);
    return wait(`!document.getElementById('theme-ai-preview').hidden || !document.getElementById('theme-ai-error').hidden`);
  };
  try {
    config.updateConfig({ theme: null, accent: null });
    await sleep(400);
    win.webContents.send('menu', 'settings');
    await wait(`!!document.getElementById('setting-theme')`);
    const before = fs.readFileSync(config.CONFIG_PATH, 'utf8');
    await js(`(() => { const input = document.getElementById('setting-theme'); input.value = ${JSON.stringify(fixtureA.toUpperCase())}; input.dispatchEvent(new Event('input')); })()`);
    check('名前を大文字小文字の区別なく絞り込める', await js(`document.querySelectorAll('.theme-picker__row').length === 1 && document.querySelector('.theme-picker__row').dataset.theme === ${JSON.stringify(fixtureA)}`));
    await js(`document.querySelector('.theme-picker__row').dispatchEvent(new MouseEvent('mouseenter'))`);
    check('マウスを載せるとプレビューが出る', await wait(`document.querySelector('#theme-preview .theme-preview__name')?.textContent === ${JSON.stringify(fixtureA)}`));
    check('プレビューだけでは設定ファイルを書き換えない', before === fs.readFileSync(config.CONFIG_PATH, 'utf8'));
    await js(`document.querySelector('.theme-picker__row').click()`);
    await sleep(400);
    check('行を押すとテーマを適用する', saved().theme === fixtureA && (await js('window.__terp.config.terminal.background')) === theme.background);
    await js(`(() => { const input = document.getElementById('setting-theme'); input.value = 'Preview'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
    check('下矢印ではプレビューだけを切り替える', await wait(`document.querySelector('#theme-preview .theme-preview__name')?.textContent === ${JSON.stringify(fixtureB)}`) && saved().theme === fixtureA);
    await js(`document.getElementById('setting-theme').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await sleep(400);
    check('Enter でテーマを適用する', saved().theme === fixtureB);

    await openAi();
    check('AI の画面に3つの質問がある', await js(`document.querySelectorAll('#theme-ai-questions > fieldset').length === 3`));
    await js(`(() => { const f = document.querySelector('#theme-ai-dialog form'); f.querySelector('[name="brightness"][value="明るい"]').checked = true; f.querySelector('[name="mood"][value="海"]').checked = true; f.querySelector('[name="moodText"]').value = '金色を少し'; f.querySelector('[name="contrast"][value="くっきり"]').checked = true; })()`);
    await createAi();
    check('答えて作成するとプレビューが出る', await js(`!document.getElementById('theme-ai-preview').hidden && document.querySelector('#theme-ai-preview .theme-preview__name').textContent === ${JSON.stringify(name)}`));
    const prompt = fs.readFileSync(promptFile, 'utf8');
    check('3つの回答と雰囲気の追記を CLI に渡す', ['明るい', '海、金色を少し', 'くっきり'].every((answer) => prompt.includes(answer)));
    check('作成だけではテーマを書かない', !fs.existsSync(path.join(dir, name)) && saved().theme === fixtureB);
    await js(`document.getElementById('theme-ai-apply').click()`);
    await wait(`!document.getElementById('theme-ai-dialog').open`);
    await sleep(400);
    check('適用でテーマのファイルを作り、カーソルの色を強調色にする', fs.existsSync(path.join(dir, name)) && saved().theme === name && (await js('window.__terp.config.chrome.accent')) === theme.cursor);
    check('Ghostty の書式で16色を保存する', config.parseGhosttyTheme(fs.readFileSync(path.join(dir, name), 'utf8')).palette.join() === theme.palette.join());
    await openAi();
    await createAi();
    await js(`document.getElementById('theme-ai-apply').click()`);
    await wait(`!document.getElementById('theme-ai-dialog').open`);
    check('同じ名前は上書きせず 2 を付ける', saved().theme === `${name} 2` && fs.existsSync(path.join(dir, `${name} 2`)) && fs.existsSync(path.join(dir, name)));

    fs.writeFileSync(modeFile, 'recover');
    fs.writeFileSync(countFile, '0');
    await openAi();
    await createAi();
    check('コントラスト不足は1回作り直して成功できる', fs.readFileSync(countFile, 'utf8') === '2' && (await js(`!document.getElementById('theme-ai-preview').hidden`)));
    await js(`document.getElementById('theme-ai-cancel').click()`);
    fs.writeFileSync(modeFile, 'low');
    fs.writeFileSync(countFile, '0');
    await openAi();
    await createAi();
    check('作り直してもコントラスト不足なら理由と再試行を出す', fs.readFileSync(countFile, 'utf8') === '2' && (await js(`!document.getElementById('theme-ai-error').hidden && document.getElementById('theme-ai-error').textContent.includes('コントラスト') && document.getElementById('theme-ai-create').textContent === 'もう一度'`)));
    fs.writeFileSync(modeFile, 'good');
    await createAi();
    check('失敗の後にもう一度作成できる', await js(`!document.getElementById('theme-ai-preview').hidden`));
    await js(`document.getElementById('theme-ai-cancel').click()`);
    fs.writeFileSync(modeFile, 'slow');
    await openAi();
    await js(`document.getElementById('theme-ai-create').click()`);
    check('作成中は作成のボタンを押せない', await js(`document.getElementById('theme-ai-create').disabled && document.getElementById('theme-ai-status').textContent === '作成中…'`));
    await js(`document.getElementById('theme-ai-cancel').click()`);
    await openAi();
    await sleep(1500);
    check('作成中に閉じた結果を、開き直した画面に出さない', await js(`document.getElementById('theme-ai-preview').hidden && document.getElementById('theme-ai-status').textContent === ''`));
    await js(`document.getElementById('theme-ai-cancel').click()`);
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'theme-ai.png'), img.toPNG()));
  } finally {
    if (previousBin === undefined) delete process.env.TERP_CLAUDE_BIN;
    else process.env.TERP_CLAUDE_BIN = previousBin;
  }
}

// TERP_SELFTEST_FILES を付けると、一時フォルダのリポジトリで、右の面のファイルの木・ファイルのタブ・
// 作業ごとのタブの切り替え・右の面の切り替えを確かめる
async function runFilesTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const repo = path.join(fs.realpathSync(outDir), 'files-repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'const answer = 42;\nfunction hello(name) {\n  return `hi ${name}`;\n}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# sample\n');
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), path.join(repo, 'icon.png'));
  fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const shot = (name) => win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()));
  const tabs = () => js(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.querySelector('.tab__name').textContent)`);
  const treeNames = () => js(`[...document.querySelectorAll('#files-tree .files__name')].map((n) => n.textContent)`);
  const clickTree = (name) => js(`[...document.querySelectorAll('#files-tree .files__item')].find((li) => li.querySelector('.files__name').textContent === ${JSON.stringify(name)}).click()`);

  await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
  const termId = await js(`window.__terp.open(${JSON.stringify(repo)})`);
  await sleep(2500);
  await js(`document.getElementById('files-toggle').click()`);
  await sleep(1000);
  const names = await treeNames();
  check('右の面にリポジトリの中身が出る', names.includes('src') && names.includes('README.md') && !names.includes('.git'), names.join(', '));
  await clickTree('src');
  await sleep(800);
  check('フォルダを開くと中身が出る', (await treeNames()).includes('a.js'));
  await clickTree('a.js');
  await sleep(1200);
  check('ファイルを押すとタブで開く', (await js('window.__terp.activeKey')) === `f:${path.join(repo, 'src', 'a.js')}`, await js('window.__terp.activeKey'));
  const t1 = await tabs();
  check('上のタブにターミナルとファイルが並ぶ', t1.length === 2 && t1[1] === 'a.js', t1.join(', '));
  const editorPath = JSON.stringify(path.join(repo, 'src', 'a.js'));
  const editorInfo = await js(`(() => {
    const editor = window.__terp.editorOf(${editorPath});
    return editor ? { language: editor.getModel().getLanguageId(), lines: editor.getModel().getLineCount() } : null;
  })()`);
  check('ファイルに色付けと行番号が付く', editorInfo?.language === 'javascript' && editorInfo.lines === 5, JSON.stringify(editorInfo));
  check('開いているファイルが木で分かる', await js(`document.querySelector('#files-tree [aria-current="true"] .files__name')?.textContent === 'a.js'`));
  await shot('1-file');

  await clickTree('icon.png');
  await sleep(1000);
  check('画像は画像として出る', await js(`Boolean(document.querySelector('.fileview:not([hidden]) .fileview__image'))`));
  await clickTree('data.bin');
  await sleep(1000);
  check('バイナリは中身を出さない', (await js(`document.querySelector('.fileview:not([hidden]) .fileview__notice')?.textContent || ''`)).includes('バイナリ'));

  // ⌘1 相当で1つ目のタブ（ターミナル）へ
  await js(`window.__terp.activateKey(window.__terp.visibleKeys()[0])`);
  await sleep(500);
  check('1つ目のタブへ移れる', (await js('window.__terp.activeKey')) === `t:${termId}`);

  // 作業の外のターミナルを開くと、上のタブはそのまとまりに切り替わる
  const looseId = await js(`window.__terp.open(${JSON.stringify(os.homedir())})`);
  await sleep(2000);
  const t2 = await tabs();
  // 起動したときの ~ のターミナルも作業の外のため、同じまとまりに並ぶ
  check('作業の外のターミナルではタブが切り替わる', !t2.includes('a.js') && t2.every((n) => n === '~'), t2.join(', '));
  // 作業の行を押すと、その作業のタブに戻る
  await js(`document.querySelector('.work[data-path=${JSON.stringify(repo)}] .work__row').click()`);
  await sleep(800);
  const t3 = await tabs();
  check('作業の行を押すとその作業のタブに戻る', t3.length === 4, t3.join(', '));

  // タブの × で閉じる
  const before = (await tabs()).length;
  await js(`[...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab__name').textContent === 'data.bin').querySelector('.tab__close').click()`);
  await sleep(500);
  check('タブの × でファイルを閉じる', (await tabs()).length === before - 1);

  // 右の面を「変更」に切り替える
  await js(`document.getElementById('panel-tab-git').click()`);
  await sleep(1200);
  check('右の面を変更に切り替えられる', (await js(`document.getElementById('git-view').hidden`)) === false && (await js(`document.getElementById('files-view').hidden`)) === true);
  await shot('2-git');
  await js(`window.__terp.activateKey('t:${looseId}')`);
}

// 合成イベントでも本物と同じ境目の処理を通し、端末の fit まで待って確かめる。
async function dragSplitGutter(js, distance) {
  return js(`(() => {
    const gutter = document.querySelector('#panes > .pane-split > .pane-gutter');
    const r = gutter.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const [type, dx, buttons] of [['pointerdown', 0, 1], ['pointermove', ${distance}, 1], ['pointerup', ${distance}, 0]]) {
      gutter.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x + dx, clientY: y }));
    }
  })()`);
}

// TERP_SELFTEST_SPLIT は、枠の操作・HTML のドラッグ・境目・メニューを確かめる。
async function runSplitTest({ win, js, check, outDir }) {
  const leaves = () => js(`(() => {
    const visit = (n) => n.type === 'pane' ? [n] : n.children.flatMap(visit);
    return visit(window.__terp.layout());
  })()`);
  const waitFor = async (test) => {
    for (let i = 0; i < 40; i++) {
      if (await test()) return true;
      await sleep(100);
    }
    return false;
  };
  await js(`Promise.all(window.__terp.tabOrder.map((key) => window.__terp.closeKey(key)))`);
  await waitFor(() => js('window.__terp.sessions.size === 0'));
  const first = await js('window.__terp.open(window.terp.home)');
  const second = await js('window.__terp.open(window.terp.home)');
  // 表示中のタブを自分の枠の端へ落とすと、そのタブが新しい枠へ移り、元の枠は1つ前に見ていたタブになる
  await js(`window.__terp.activateKey('t:${first}')`);
  const own = (await leaves())[0].id;
  await js(`window.__terp.dropTab('t:${first}', ${JSON.stringify(own)}, 'right')`);
  await sleep(300);
  const selfSplit = await leaves();
  check('表示中のタブを自分の枠の端へ落とすと、1つ前のタブと2枠になる',
    selfSplit.length === 2 && selfSplit[0].key === `t:${second}` && selfSplit[1].key === `t:${first}` && (await js('window.__terp.sessions.size')) === 2,
    selfSplit.map((p) => p.key).join(','));
  await js(`window.__terp.dropTab('t:${first}', ${JSON.stringify(selfSplit[0].id)}, 'center')`);
  await waitFor(async () => (await leaves()).length === 1);
  await js(`window.__terp.activateKey('t:${first}')`);
  const target = (await leaves())[0].id;
  await js(`window.__terp.dropTab('t:${second}', ${JSON.stringify(target)}, 'right')`);
  await sleep(300);
  check('右へ落とすと2枠になる', (await leaves()).length === 2);
  check('両方の端末に幅と高さがある', await js(`[${first}, ${second}].every((id) => {
    const el = window.__terp.sessions.get(id).el;
    const r = el.getBoundingClientRect();
    return !el.hidden && r.width > 0 && r.height > 0;
  })`));
  check('表示中の端末には両方 WebGL が付く', await js(`[${first}, ${second}].every((id) => Boolean(window.__terp.sessions.get(id).webgl))`));

  const third = await js('window.__terp.open(window.terp.home)');
  await js(`(() => {
    const tab = [...document.querySelectorAll('#tabs .tab')].find((el) => el.dataset.key === 't:${second}');
    const pane = document.querySelector('[data-pane-id="${target}"]');
    const r = pane.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    const point = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + r.width / 2, clientY: r.bottom - 2 };
    pane.dispatchEvent(new DragEvent('dragover', point));
    pane.dispatchEvent(new DragEvent('drop', point));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  })()`);
  check('上のタブの dragstart・dragover・drop でも下に分割できる', await waitFor(async () => (await leaves()).length === 3));
  if (outDir) {
    await sleep(800);
    fs.writeFileSync(path.join(outDir, 'split.png'), (await win.webContents.capturePage()).toPNG());
  }
  check('落とす予告は終わったら消える', await js("!document.querySelector('.pane[data-drop]')"));

  const beforeSizes = await js('window.__terp.layout().sizes');
  const beforeCols = await js(`window.__terp.sessions.get(${first}).term.cols`);
  await dragSplitGutter(js, 70);
  check('境目をずらすと割合が変わる', JSON.stringify(beforeSizes) !== JSON.stringify(await js('window.__terp.layout().sizes')));
  check('境目をずらすと左の端末の列数が変わる', await waitFor(() => js(`window.__terp.sessions.get(${first}).term.cols !== ${beforeCols}`)));
  await js(`document.querySelector('[data-pane-id="${target}"] .xterm-helper-textarea').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  check('端末を押すとその枠が操作中になる', (await js('window.__terp.activeKey')) === `t:${first}`);
  await js(`document.querySelector('#tabs .tab[data-key="t:${third}"]').click()`);
  const thirdPane = (await leaves()).find((p) => p.key === `t:${third}`);
  check('別の枠のタブを押すとその枠が操作中になる', (await js('window.__terp.activePaneId')) === thirdPane.id && (await leaves()).length === 3);
  const sessionCount = await js('window.__terp.sessions.size');
  await js(`document.querySelector('[data-pane-id="${thirdPane.id}"] .pane__close').click()`);
  check('枠の × は枠だけを閉じる', (await leaves()).length === 2 && (await js('window.__terp.sessions.size')) === sessionCount);
  check('隠した端末から WebGL が外れる', await js(`!window.__terp.sessions.get(${third}).webgl`));
  await js(`window.__terp.closeKey('t:${third}')`);
  await waitFor(() => js(`!window.__terp.sessions.has(${third})`));
  await js(`window.__terp.closeKey('t:${second}')`);
  check('補充するタブが無い枠は閉じる', await waitFor(async () => (await leaves()).length === 1));

  const count = await js('window.__terp.sessions.size');
  win.webContents.send('menu', 'split-right');
  check('右に分割のメニューで枠と新しい端末が増える', await waitFor(async () => (await leaves()).length === 2 && (await js('window.__terp.sessions.size')) === count + 1));
  const right = (await leaves())[1];
  win.webContents.send('menu', 'pane-left');
  await sleep(100);
  check('左の枠のメニューで隣へ移る', (await js('window.__terp.activeKey')) === `t:${first}`);
  win.webContents.send('menu', 'pane-right');
  await sleep(100);
  check('右の枠のメニューで隣へ移る', (await js('window.__terp.activePaneId')) === right.id);
}

// TERP_SELFTEST_PANETITLE は、帯の更新・改名・分割・ファイル・端末の収まりを確かめる。
async function runPaneTitleTest({ js, check }) {
  if (!process.env.TERP_CONFIG_DIR) throw new Error('題名の帯の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-pane-title-')));
  const repo = path.join(dir, 'title-repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'pane-title'], { cwd: repo });
  const file = path.join(repo, 'src', 'sample.js');
  fs.writeFileSync(file, 'const value = 1;\n');
  const fake = path.join(dir, 'claude');
  const node = execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
  fs.copyFileSync(node, fake);
  fs.chmodSync(fake, 0o755);
  const script = path.join(dir, 'title-agent.js');
  fs.writeFileSync(script, `require('child_process').execSync('stty -echo', { stdio: 'inherit' });
const out = (text) => process.stdout.write(text);
out('pane-title-ready\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (command) => {
  if (command.startsWith('title ')) out('\\x1b]2;✳ ' + command.slice(6) + '\\x07');
  if (command === 'work') out('\\x1b]2;⠂ 状態の確認\\x07');
  if (command === 'permission') out('\\x1b]9;permission required\\x07');
});
`);
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const wait = async (condition) => {
    for (let i = 0; i < 200; i++) { if (await condition()) return true; await sleep(50); }
    throw new Error('題名の帯の自己診断で応答を待ち切れなかった');
  };
  const header = (id) => `window.__terp.sessions.get(${id}).el.closest('.pane').querySelector('.pane__title')`;
  const input = (id, command) => js(`window.__terp.sessions.get(${id}).term.input(${JSON.stringify(command + '\r')}, true)`);
  const name = (id) => js(`${header(id)}.querySelector('.pane__name')?.textContent`);
  const leaves = () => js(`(() => {
    const visit = (n) => n.type === 'pane' ? [n] : n.children.flatMap(visit);
    return visit(window.__terp.layout());
  })()`);
  const rename = async (id, value, key = 'Enter') => {
    await js(`${header(id)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await js(`(() => {
      const field = ${header(id)}.querySelector('input');
      field.value = ${JSON.stringify(value)};
    })()`);
    await sleep(650);
    check('定期更新中も名前の入力を保つ', await js(`${header(id)}.querySelector('input')?.value === ${JSON.stringify(value)}`));
    await js(`${header(id)}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
  };
  await js(`Promise.all(window.__terp.tabOrder.map((key) => window.__terp.closeKey(key)))`);
  await wait(() => js('window.__terp.sessions.size === 0'));
  const added = await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
  if (!added.ok) throw new Error(added.error);
  const first = await js(`window.__terp.open(${JSON.stringify(repo)})`);
  await wait(() => js(`window.__terp.bufferText(${first}).length > 0`));
  await js(`window.terp.write(${first}, ${JSON.stringify(quote(fake) + ' ' + quote(script) + '\r')})`);
  await wait(() => js(`window.__terp.sessions.get(${first}).program === 'claude' && window.__terp.bufferText(${first}).includes('pane-title-ready')`));
  const longTitle = '枠の上端で長い会話の題名を最後まで確認し、端末とファイルを並べて作業するための表示と名前の変更の検証';
  await input(first, 'title ' + longTitle);
  await wait(async () => await name(first) === longTitle);
  check('OSC 2 の長い題名を字数で切らず帯と title に出す', await js(`${header(first)}.querySelector('.pane__name').textContent === ${JSON.stringify(longTitle)} && ${header(first)}.title.includes(${JSON.stringify(longTitle)})`));
  check('名前の省略は帯の実際の幅だけで決める', await js(`(() => {
    const h = ${header(first)}, n = h.querySelector('.pane__name'), style = getComputedStyle(n);
    return style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.maxWidth === 'none'
      && n.textContent === ${JSON.stringify(longTitle)} && n.getBoundingClientRect().width <= h.getBoundingClientRect().width;
  })()`));
  check('帯にプログラムとリポジトリとブランチ、説明にフルパスを出す', await js(`${header(first)}.querySelector('.pane__detail').textContent === 'claude · title-repo / pane-title' && ${header(first)}.title.includes('claude') && ${header(first)}.title.includes(${JSON.stringify(repo)})`));
  await input(first, 'work');
  await wait(() => js(`${header(first)}.dataset.agentState === 'working'`));
  check('帯と一覧で状態の属性・印の見た目・読み上げ名を揃える', await js(`(() => {
    const s = window.__terp.sessions.get(${first}), h = ${header(first)};
    const a = h.querySelector('.session__dot'), b = s.li.querySelector('.session__dot');
    return h.dataset.state === s.li.dataset.state && h.dataset.agentState === s.li.dataset.agentState
      && a.getAttribute('aria-label') === b.getAttribute('aria-label')
      && getComputedStyle(a).animationName === getComputedStyle(b).animationName
      && getComputedStyle(a).borderTopColor === getComputedStyle(b).borderTopColor;
  })()`));
  await input(first, 'permission');
  await wait(() => js(`${header(first)}.dataset.agentState === 'waiting'`));
  check('状態の変化で許可待ちの印を更新する', await js(`${header(first)}.dataset.state === 'notify' && ${header(first)}.querySelector('.session__dot').textContent === '!'`));
  await input(first, 'title ' + longTitle);
  await wait(async () => await name(first) === longTitle);
  await rename(first, '帯で変更した名前');
  check('帯の改名を帯・タブ・一覧に反映する', await js(`${header(first)}.querySelector('.pane__name').textContent === '帯で変更した名前' && document.querySelector('.tab[data-key="t:${first}"] .tab__name').textContent === '帯で変更した名前' && window.__terp.sessions.get(${first}).li.querySelector('.session__name').textContent === '帯で変更した名前'`));
  await rename(first, '取り消す名前', 'Escape');
  check('Esc は改名を取り消す', await name(first) === '帯で変更した名前');
  await rename(first, '');
  check('空の名前は自動の題名へ戻す', await name(first) === longTitle && await js(`window.__terp.sessions.get(${first}).customName === null`));
  const second = await js(`window.__terp.open(${JSON.stringify(repo)})`);
  await js(`window.__terp.rename(${second}, '右の端末'); window.__terp.activate(${first})`);
  const target = (await leaves())[0].id;
  await js(`window.__terp.dropTab('t:${second}', ${JSON.stringify(target)}, 'right')`);
  await wait(() => js(`document.querySelectorAll('#panes .pane__title').length === 2`));
  check('左右の枠がそれぞれの名前を出す', await name(first) === longTitle && await name(second) === '右の端末');
  check('分割中の操作中の帯の線を強調色に揃える', await js(`(() => {
    const p = document.querySelector('.pane[data-active="true"]');
    return getComputedStyle(p.querySelector('.pane__title')).borderBottomColor === getComputedStyle(p).outlineColor;
  })()`));
  check('× は帯の中に収まり文字と重ならず押せる', await js(`[...document.querySelectorAll('#panes .pane__title')].every((h) => {
    const b = h.querySelector('.pane__close'), r = b.getBoundingClientRect(), t = h.getBoundingClientRect();
    return !b.hidden && r.top >= t.top && r.bottom <= t.bottom && r.right <= t.right
      && h.querySelector('.pane__name').getBoundingClientRect().right <= r.left
      && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b;
  })`));
  await js(`new Promise((resolve) => {
    const s = window.__terp.sessions.get(${first});
    s.term.write('\\x1b[2J\\x1b[H\\x1b[' + s.term.rows + ';1H最終行の確認', resolve);
  })`);
  check('帯の下で fit し、端末の最終行まで本文の内側に収まる', await js(`(() => {
    const s = window.__terp.sessions.get(${first}), p = s.el.closest('.pane');
    const h = p.querySelector('.pane__title').getBoundingClientRect(), body = p.querySelector('.pane__body').getBoundingClientRect();
    const r = s.el.querySelector('.xterm-screen').getBoundingClientRect(), box = p.getBoundingClientRect();
    const fit = s.fit.proposeDimensions();
    return body.top >= h.bottom && r.top >= body.top && r.bottom <= body.bottom + 1 && body.bottom <= box.bottom + 1
      && s.term.rows === fit.rows && s.term.cols === fit.cols
      && window.__terp.bufferText(${first}, { visible: true }).includes('最終行の確認');
  })()`));
  await js(`window.__terp.openFile(${JSON.stringify(file)})`);
  await wait(() => js(`Boolean(window.__terp.editorOf(${JSON.stringify(file)}))`));
  const fileHeader = `document.querySelector('.pane[data-active="true"] .pane__title')`;
  check('ファイルの帯に名前と相対パスを出し、端末の状態を残さない', await js(`${fileHeader}.querySelector('.pane__name').textContent === 'sample.js' && ${fileHeader}.querySelector('.pane__detail').textContent === 'src/sample.js' && !${fileHeader}.hasAttribute('data-state') && ${fileHeader}.querySelector('.session__dot').hidden`));
  await js(`${fileHeader}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  check('ファイルの帯では改名しない', await js(`!${fileHeader}.querySelector('input')`));
  await js(`window.__terp.editorOf(${JSON.stringify(file)}).getModel().setValue('const value = 2;\\n')`);
  await wait(() => js(`${fileHeader}.querySelector('.pane__name').textContent === 'sample.js ●'`));
  check('未保存の印をタブと帯に揃える', await js(`document.querySelector('.tab[data-key="' + CSS.escape(${JSON.stringify('f:' + file)}) + '"] .tab__name').textContent === 'sample.js ●'`));
  await js(`window.__terp.editorOf(${JSON.stringify(file)}).getModel().setValue('const value = 1;\\n')`);
  await wait(() => js(`${fileHeader}.querySelector('.pane__name').textContent === 'sample.js'`));
  await js(`document.querySelector('.pane[data-active="true"] .pane__close').click()`);
  check('× で枠だけ閉じ、タブを残す', (await leaves()).length === 1 && await js(`window.__terp.tabOrder.includes(${JSON.stringify('f:' + file)})`));
  check('1枠でも帯を保ち、× を隠す', await js(`document.querySelectorAll('#panes .pane__title').length === 1 && document.querySelector('.pane__close').hidden`));
}

// TERP_SELFTEST_DROPPATHS は、パスの入力・閲覧枠の除外・既存の分割との切り替えを確かめる。
async function runDropPathsTest({ js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(path.resolve(outDir), 'drop-paths-'));
  const file = path.join(repo, 'note.txt');
  const other = path.join(repo, 'other file.txt');
  const folder = path.join(repo, 'folder name');
  const image = path.join(repo, 'icon.png');
  fs.writeFileSync(file, 'before\n');
  fs.writeFileSync(other, 'other\n');
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const leaves = () => js(`(() => {
    const visit = (n) => n.type === 'pane' ? [n] : n.children.flatMap(visit);
    return visit(window.__terp.layout());
  })()`);
  const waitFor = async (test) => {
    for (let i = 0; i < 70; i++) {
      if (await test()) return true;
      await sleep(100);
    }
    return false;
  };
  await js(`Promise.all(window.__terp.tabOrder.map((key) => window.__terp.closeKey(key)))`);
  await waitFor(() => js('window.__terp.sessions.size === 0'));
  await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
  const first = await js(`window.__terp.open(${JSON.stringify(repo)})`);
  const target = (await leaves())[0].id;
  const second = await js(`window.__terp.open(${JSON.stringify(repo)})`);
  await js(`window.__terp.dropTab('t:${first}', ${JSON.stringify(target)}, 'left')`);
  const terminalPane = (await leaves()).find((p) => p.key === `t:${first}`).id;
  const pane = JSON.stringify(terminalPane);
  await js(`window.__terp.activateKey('t:${second}')`);
  await sleep(2000);

  const paths = ['/tmp/my file.txt', '/tmp/日本語'];
  const expected = '/tmp/my\\ file.txt /tmp/日本語 ';
  const terminalInput = () => js(`(() => {
    const buf = window.__terp.sessions.get(${first}).term.buffer.active;
    let row = buf.baseY + buf.cursorY;
    let text = buf.getLine(row).translateToString(false);
    while (row > 0 && buf.getLine(row).isWrapped) text = buf.getLine(--row).translateToString(false) + text;
    return text;
  })()`);
  const paste = await js(`(async () => {
    const term = window.__terp.sessions.get(${first}).term;
    await new Promise((resolve) => term.write('\x1b[?2004h', resolve));
    const input = [];
    const listener = term.onData((text) => input.push(text));
    const accepted = window.__terp.dropPaths(${pane}, ${JSON.stringify(paths)});
    listener.dispose();
    return { accepted, input };
  })()`);
  check('括弧付き貼り付けで複数のパスを1回で送る', paste.accepted && paste.input.length === 1 && paste.input[0] === '\x1b[200~' + expected + '\x1b[201~');
  check('空白を逃がしたパスと日本語のパスが入力行に並ぶ', await waitFor(async () => (await terminalInput()).includes(expected)));
  check('Enter を送らず、落とした端末の枠に焦点を移す', !paste.input.join('').includes('\r') && !paste.input.join('').includes('\n') && await js(`window.__terp.activePaneId === ${pane} && document.activeElement === window.__terp.sessions.get(${first}).el.querySelector('.xterm-helper-textarea')`));

  await js(`window.__terp.activateKey('t:${second}')`);
  await js(`window.__terp.openFile(${JSON.stringify(file)}).then(() => true)`);
  const editorPane = (await leaves()).find((p) => p.key === `f:${file}`).id;
  const editor = `window.__terp.editorOf(${JSON.stringify(file)})`;
  await js(`${editor}.setPosition({ lineNumber: 1, column: 3 })`);
  await js(`window.__terp.dropPaths(${JSON.stringify(editorPane)}, ${JSON.stringify(paths)})`);
  check('文字のエディタにはカーソル位置に素のパスを改行で入れる', (await js(`${editor}.getValue()`)) === 'be' + paths.join('\n') + 'fore\n');

  await js(`window.__terp.openFile(${JSON.stringify(image)}).then(() => true)`);
  const imagePane = (await leaves()).find((p) => p.key === `f:${image}`).id;
  const beforeImage = await js(`document.querySelector('[data-pane-id="${imagePane}"] .fileview__image').src`);
  const beforeLayout = await js('JSON.stringify(window.__terp.layout())');
  const ignored = await js(`window.__terp.dropPaths(${JSON.stringify(imagePane)}, ${JSON.stringify(paths)})`);
  check('画像の閲覧枠ではパスを入れず、表示と配置を保つ', !ignored && (await js(`document.querySelector('[data-pane-id="${imagePane}"] .fileview__image').src`)) === beforeImage && (await js('JSON.stringify(window.__terp.layout())')) === beforeLayout);

  const href = await js('location.href');
  const guarded = await js(`(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['sample'], 'sample.txt'));
    const options = { bubbles: true, cancelable: true, dataTransfer };
    const over = new DragEvent('dragover', options);
    const drop = new DragEvent('drop', options);
    document.dispatchEvent(over);
    document.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  })()`);
  await sleep(100);
  check('枠の外の files 付きドロップでも窓が遷移しない', guarded && (await js('location.href')) === href);
  check('Finder のドラッグでは入力枠だけを囲み、分割の予告を出さない', await js(`(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['sample'], 'sample.txt'));
    const terminal = document.querySelector('[data-pane-id="${terminalPane}"]');
    const image = document.querySelector('[data-pane-id="${imagePane}"]');
    const options = { bubbles: true, cancelable: true, dataTransfer };
    terminal.querySelector('.xterm-helper-textarea').dispatchEvent(new DragEvent('dragover', options));
    const highlighted = terminal.dataset.dropPaths === 'true' && !document.querySelector('.pane[data-drop]');
    image.dispatchEvent(new DragEvent('dragover', options));
    const ignored = !document.querySelector('.pane[data-drop-paths], .pane[data-drop]');
    document.dispatchEvent(new DragEvent('drop', options));
    return highlighted && ignored;
  })()`));

  await js(`window.__terp.activateKey('t:${first}'); window.__terp.setPanel('files')`);
  await waitFor(() => js(`Boolean([...document.querySelectorAll('#files-tree .files__name')].find((el) => el.textContent === 'other file.txt'))`));
  const dragRow = (name, alt, paneId = terminalPane) => js(`(() => {
    const row = [...document.querySelectorAll('#files-tree .files__item')].find((el) => el.querySelector('.files__name').textContent === ${JSON.stringify(name)});
    const pane = document.querySelector('[data-pane-id="${paneId}"]');
    const rect = pane.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    const point = { bubbles: true, cancelable: true, dataTransfer, altKey: ${alt}, clientX: rect.right - 2, clientY: rect.top + rect.height / 2 };
    pane.dispatchEvent(new DragEvent('dragover', point));
    const result = { path: dataTransfer.getData('text/x-terp-path'), highlighted: pane.dataset.dropPaths === 'true', split: Boolean(pane.dataset.drop) };
    pane.dispatchEvent(new DragEvent('drop', point));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    return result;
  })()`);
  const beforeCount = (await leaves()).length;
  const altFile = await dragRow('other file.txt', true);
  const escapedOther = other.replace(/ /g, '\\ ') + ' ';
  check('右のファイルを ⌥ 付きで落とすとパスが入り、枠は増えない', altFile.path === other && altFile.highlighted && !altFile.split && (await leaves()).length === beforeCount && await waitFor(async () => (await terminalInput()).includes(escapedOther)));
  const altFolder = await dragRow('folder name', true);
  check('右のフォルダも ⌥ 付きでパスを入力できる', altFolder.path === folder && (await leaves()).length === beforeCount && await waitFor(async () => (await terminalInput()).includes(folder.replace(/ /g, '\\ ') + ' ')));

  await js(`window.__terp.activateKey(${JSON.stringify(`f:${file}`)})`);
  const nextEditorPane = (await leaves()).find((p) => p.key === `f:${file}`).id;
  await js(`${editor}.setPosition({ lineNumber: 1, column: 1 })`);
  const beforeEditor = await js(`${editor}.getValue()`);
  await dragRow('other file.txt', true, nextEditorPane);
  check('右のファイルを ⌥ 付きでエディタに落とすと素のパスが入る', (await js(`${editor}.getValue()`)).includes(other) && (await js(`${editor}.getValue()`)).length === beforeEditor.length + other.length && (await leaves()).length === beforeCount);
  const normal = await dragRow('other file.txt', false);
  check('⌥ 無しのファイルのドロップは従来どおり枠を分ける', normal.split && !normal.highlighted && await waitFor(async () => (await leaves()).length === beforeCount + 1));
  check('ドロップ後は入力枠の強調と分割の予告を消す', await js(`!document.querySelector('.pane[data-drop-paths], .pane[data-drop]')`));
}

// TERP_SELFTEST_PATHLINKS を付けると、実在確認・折り返し・ファイルの行と桁への移動を確かめる
async function runPathLinksTest({ js, check, outDir }) {
  // シェルの作業場所は実体のパス（/private/var/…）で返るため、比べるパスも実体にそろえる
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(outDir), 'pathlinks-')));
  const source = path.join(dir, 'src', 'a.js');
  const notes = path.join(dir, 'notes.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n');
  fs.writeFileSync(notes, '# notes\n');
  const id = await js(`window.__terp.open(${JSON.stringify(dir)})`);
  await sleep(2500);
  const cols = await js(`window.__terp.sessions.get(${id}).term.cols`);
  let deep = dir;
  for (let i = 0; path.join(deep, 'wrapped.js').length <= cols + 40; i++) deep = path.join(deep, `nested-${i}-${'x'.repeat(40)}`);
  const longPath = path.join(deep, 'wrapped.js');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(longPath, 'const wrapped = true;\n');
  await js(`window.terp.write(${id}, 'stty -echo\\r')`);
  await sleep(300);
  const outputs = ['src/a.js:3:2', notes, '(src/a.js)', 'missing/nothing.js:1', longPath];
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = "printf '\\033[2J\\033[H" + '%s\\n'.repeat(outputs.length) + "' " + outputs.map(quote).join(' ') + '\r';
  await js(`window.terp.write(${id}, ${JSON.stringify(command)})`);
  let links = [];
  for (let i = 0; i < 40; i++) {
    links = await js(`window.__terp.terminalLinks(${id})`);
    if (links.some((link) => link.text === longPath)) break;
    await sleep(100);
  }
  check('相対パスと行・桁がリンクになる', links.some((link) => link.text === 'src/a.js:3:2' && link.path === source && link.line === 3 && link.column === 2));
  check('絶対パスがリンクになる', links.some((link) => link.text === notes && link.path === notes));
  check('括弧を除いたパスがリンクになる', links.some((link) => link.text === 'src/a.js' && link.path === source));
  check('存在しないパスはリンクにならない', !links.some((link) => link.text === 'missing/nothing.js:1'));
  const wrapped = links.filter((link) => link.text === longPath);
  check('折り返された長いパスが1つのリンクになる', wrapped.length === 1 && wrapped[0].range.end.y > wrapped[0].range.start.y);
  check('相対パスのリンクを押せる', await js(`window.__terp.activateTerminalLink(${id}, 'src/a.js:3:2')`));
  check('リンクのファイルがタブで開く', (await js('window.__terp.activeKey')) === `f:${source}`);
  const position = await js(`window.__terp.editorOf(${JSON.stringify(source)})?.getPosition()`);
  check('カーソルが3行目2桁目に移る', position?.lineNumber === 3 && position?.column === 2, JSON.stringify(position));
  await js(`window.__terp.activate(${id})`);
  await js(`window.__terp.clickTerminalLink(${id}, ${JSON.stringify(notes)})`);
  await sleep(300);
  check('普通のクリックではリンクを開かない', (await js('window.__terp.activeKey')) === `t:${id}`);
  await js(`window.__terp.clickTerminalLink(${id}, ${JSON.stringify(notes)}, { metaKey: true })`);
  await sleep(300);
  check('⌘クリックでリンクを開く', (await js('window.__terp.activeKey')) === `f:${notes}`);
  await js(`window.__terp.activate(${id})`);
  check('右クリックでリンクを開き、右クリックの既定の動きは止める', await js(`window.__terp.rightClickTerminalLink(${id}, 'src/a.js:3:2')`));
  await sleep(300);
  check('右クリックで開いたファイルがタブで出る', (await js('window.__terp.activeKey')) === `f:${source}`);
  await js(`window.__terp.activate(${id})`);
  check('リンクの外の右クリックは止めない', !(await js(`(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    window.__terp.sessions.get(${id}).el.querySelector('.xterm-screen').dispatchEvent(event);
    return event.defaultPrevented;
  })()`)));
  check('絶対パスのリンクを押せる', await js(`window.__terp.activateTerminalLink(${id}, ${JSON.stringify(notes)})`));
  check('notes.md がタブで開く', (await js('window.__terp.activeKey')) === `f:${notes}`);
  await js(`window.__terp.activate(${id})`);
  await js(`window.__terp.editorOf(${JSON.stringify(source)}).setPosition({ lineNumber: 1, column: 1 })`);
  await js(`window.__terp.activateTerminalLink(${id}, 'src/a.js:3:2')`);
  const reopened = await js(`window.__terp.editorOf(${JSON.stringify(source)}).getPosition()`);
  check('開いているタブでも指定の行・桁に移る', (await js('window.__terp.activeKey')) === `f:${source}` && reopened.lineNumber === 3 && reopened.column === 2);
  await js(`window.terp.write(${id}, 'stty echo\\r')`);
}

// TERP_SELFTEST_SUBAGENTS を付けると、偽の会話で一覧・記録の追記・設定の入口を確かめる
async function runSubagentsTest({ win, js, check, outDir }) {
  const savedDirs = process.env.TERP_CLAUDE_DIRS;
  const savedSession = process.env.TERP_FAKE_CLAUDE_SESSION;
  const dirs = [path.join(outDir, 'claude-test'), path.join(outDir, 'claude2-test')];
  const session = 'selftest-session';
  const folders = dirs.map((dir) => path.join(dir, 'projects', 'x', session, 'subagents'));
  for (const dir of folders) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(folders[0], 'agent-running.jsonl');
  const line = (type, content) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } }) + '\n';
  const initial = line('user', [{ type: 'text', text: '画面を確認する' }]) +
    line('assistant', [{ type: 'thinking', thinking: '表示しない内容' }, { type: 'text', text: '確認を開始する' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/sample/app.js' } }]) +
    line('user', [{ type: 'tool_result', content: '確認結果: ' + 'a'.repeat(500) }]);
  fs.writeFileSync(file, initial);
  fs.writeFileSync(path.join(folders[0], 'agent-running.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: '画面の確認' }));
  for (let i = 1; i <= 2; i++) {
    const folder = folders[i - 1];
    fs.writeFileSync(path.join(folder, `agent-finished-${i}.jsonl`), line('assistant', [{ type: 'text', text: `確認完了 ${i}` }]));
    fs.writeFileSync(path.join(folder, `agent-finished-${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `完了した確認 ${i}`, finished: true }));
  }
  process.env.TERP_CLAUDE_DIRS = dirs.join(path.delimiter);
  process.env.TERP_FAKE_CLAUDE_SESSION = session;
  const wait = async (test, ms = 7000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await test()) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    const id = await js('window.__terp.activeId');
    const group = `window.__terp.sessions.get(${id}).li.nextElementSibling`;
    const row = `${group}.querySelector('.subagent[data-id="running"]')`;
    await js('window.__terp.refreshSubagents()');
    check('ターミナルの直下に動いているサブエージェントが出る', await js(`Boolean(${row} && ${row}.textContent.includes('画面の確認') && ${row}.textContent.includes('Read: app.js'))`));
    check('終わったものは 2 件に畳まれる', await js(`${group}.querySelector('.subagents__finished').textContent.includes('終わったもの 2 件') && ${group}.querySelectorAll('.subagent').length === 1`));
    await js(`${group}.querySelector('.subagents__finished').click()`);
    check('終わったものを開ける', await js(`${group}.querySelectorAll('.subagent').length === 3`));
    await js(`${group}.querySelector('.subagents__finished').click()`);
    check('もう一度押すと畳める', await js(`${group}.querySelectorAll('.subagent').length === 1`));
    fs.appendFileSync(file, line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'echo subagent-updated' } }]));
    check('一覧が追記された道具の操作に変わる', await wait(() => js(`${row}.textContent.includes('Bash: echo subagent-updated')`)));
    await js(`${row}.click()`);
    const key = `s:${fs.realpathSync(file)}`;
    check('サブエージェントのタブが開く', await wait(() => js(`window.__terp.activeKey === ${JSON.stringify(key)}`)));
    check('記録に話す・道具・結果が出る', await wait(() => js(`['text', 'tool', 'result'].every((type) => document.querySelector('.subagent-view:not([hidden]) .subagent-view__entry[data-type="' + type + '"]'))`)));
    check('考えている内容を出さない', await js(`!document.querySelector('.subagent-view:not([hidden])').textContent.includes('表示しない内容')`));
    fs.appendFileSync(file, line('assistant', [{ type: 'text', text: '追記された確認結果' }]));
    check('記録のタブへ続きを足す', await wait(() => js(`document.querySelector('.subagent-view:not([hidden])').textContent.includes('追記された確認結果')`)));
    await sleep(400);
    const savedTabs = await js('window.terp.loadTabs()');
    check('記録のタブを控えに残さない', savedTabs.ok && !savedTabs.value.order.includes(key) && savedTabs.value.active !== key);
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'subagents.png'), img.toPNG()));
    await js(`[...document.querySelectorAll('#tabs .tab')].find((tab) => tab.dataset.key === ${JSON.stringify(key)}).querySelector('.tab__close').click()`);
    check('サブエージェントのタブを閉じられる', await js(`!window.__terp.tabOrder.includes(${JSON.stringify(key)}) && !document.querySelector('.subagent-view')`));
    await js(`document.getElementById('settings-open').click()`);
    check('設定のボタンで設定の画面が開く', await wait(() => js(`!document.getElementById('settings').hidden`)));
  } finally {
    if (savedDirs === undefined) delete process.env.TERP_CLAUDE_DIRS;
    else process.env.TERP_CLAUDE_DIRS = savedDirs;
    if (savedSession === undefined) delete process.env.TERP_FAKE_CLAUDE_SESSION;
    else process.env.TERP_FAKE_CLAUDE_SESSION = savedSession;
  }
}

// TERP_SELFTEST_EDITOR を付けると、一時ファイルで編集・保存・外の変更・閉じる確認を確かめる
async function runEditorTest({ win, js, check, outDir }) {
  const dir = fs.mkdtempSync(path.join(outDir, 'editor-'));
  const file = path.join(dir, 'sample.js');
  const image = path.join(dir, 'icon.png');
  const original = 'const answer = 42;\n';
  fs.writeFileSync(file, original);
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image);
  const p = JSON.stringify(file);
  const editor = `window.__terp.editorOf(${p})`;
  const value = () => js(`${editor}?.getValue()`);
  const tabName = () => js(`[...document.querySelectorAll('#tabs .tab')].find((t) => t.dataset.key === ${JSON.stringify(`f:${file}`)})?.querySelector('.tab__name').textContent`);
  const wait = async (test, ms = 7000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await test()) return true;
      await sleep(100);
    }
    return false;
  };
  const edit = (text) => js(`(() => {
    const e = ${editor};
    const pos = e.getModel().getFullModelRange().getEndPosition();
    e.executeEdits('selftest', [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: ${JSON.stringify(text)} }]);
  })()`);
  const dialog = () => js(`document.getElementById('file-dialog').open`);
  // 確認の画面が開いた直後は押しても届かないことがあるため、少し待ってから押す
  const choose = async (choice) => {
    await sleep(300);
    await js(`document.querySelector('#file-dialog [value="${choice}"]').click()`);
  };
  const banner = () => js(`document.querySelector('.fileview:not([hidden]) .fileview__banner:not([hidden])')?.textContent || ''`);
  const external = (text) => {
    const before = fs.statSync(file).mtimeMs;
    fs.writeFileSync(file, text);
    const time = new Date(Math.max(Date.now(), before + 20));
    fs.utimesSync(file, time, time);
  };
  const close = () => { win.webContents.send('menu', 'close'); };

  await js(`window.__terp.openFile(${p}).then(() => true)`);
  check('文字のファイルが Monaco で開く', await js(`Boolean(${editor} && document.querySelector('.fileview:not([hidden]) .monaco-editor'))`) && (await value()) === original);
  check('拡張子から言語を選ぶ', (await js(`${editor}.getModel().getLanguageId()`)) === 'javascript');
  await edit('// edited\n');
  check('編集するとタブに ● が付く', (await tabName()).endsWith(' ●'));
  win.webContents.send('menu', 'save');
  check('⌘S で保存して ● が消える', await wait(async () => fs.readFileSync(file, 'utf8') === original + '// edited\n' && !(await tabName()).includes('●')));

  const next = 'const answer = 100;\n';
  await js(`${editor}.setPosition({ lineNumber: 1, column: 5 })`);
  external(next);
  check('未保存の変更が無ければ外の変更を取り込む', await wait(async () => (await value()) === next));
  check('外の変更を取り込んでもカーソルを保つ', await js(`${editor}.getPosition().column === 5`));

  await edit('// local\n');
  const local = await value();
  const outside = 'const outside = true;\n';
  external(outside);
  check('未保存の変更があれば外の変更を帯で知らせる', await wait(async () => (await banner()).includes('外で変更されました')) && (await value()) === local);
  await js(`[...document.querySelectorAll('.fileview:not([hidden]) .fileview__banner button')].find((b) => b.textContent === 'このまま').click()`);
  check('このままを選ぶと帯を閉じる', (await banner()) === '');
  win.webContents.send('menu', 'save');
  check('このままの後の保存でも上書きを確認する', await wait(dialog) && fs.readFileSync(file, 'utf8') === outside);
  await choose('cancel');
  await wait(async () => !(await dialog()));
  check('上書きのキャンセルでは外の内容を保つ', fs.readFileSync(file, 'utf8') === outside && (await tabName()).includes('●'));
  win.webContents.send('menu', 'save');
  await wait(dialog);
  await choose('accept');
  check('上書きを選ぶと保存する', await wait(async () => fs.readFileSync(file, 'utf8') === local && !(await tabName()).includes('●')));

  await edit('// discard\n');
  close();
  check('未保存のタブを閉じると確認する', await wait(dialog));
  await choose('cancel');
  await wait(async () => !(await dialog()));
  check('キャンセルでタブを残す', await js(`Boolean(${editor})`));
  close();
  await wait(dialog);
  await choose('discard');
  check('保存せずに閉じるとタブを閉じてファイルを保つ', await wait(async () => !(await js(`Boolean(${editor})`))) && fs.readFileSync(file, 'utf8') === local);

  await js(`window.__terp.openFile(${p}).then(() => true)`);
  check('開き直した文字のファイルもエディタになる', (await value()) === local);
  await edit('// keep\n');
  await js(`document.querySelector('.fileview:not([hidden]) .fileview__head button').click()`);
  check('再読み込みでも未保存の変更を確認する', await wait(dialog));
  await choose('cancel');
  await wait(async () => !(await dialog()));
  check('再読み込みのキャンセルで編集を保つ', (await value()) === local + '// keep\n');
  external('// reloaded\n');
  await wait(async () => (await banner()).includes('外で変更されました'));
  await js(`[...document.querySelectorAll('.fileview:not([hidden]) .fileview__banner button')].find((b) => b.textContent.startsWith('読み直す')).click()`);
  await wait(dialog);
  await choose('accept');
  check('帯から読み直すと画面の変更を捨てる', await wait(async () => (await value()) === '// reloaded\n' && !(await tabName()).includes('●')));
  fs.unlinkSync(file);
  check('削除されてもタブを残して帯で知らせる', await wait(async () => (await banner()).includes('このファイルは消えました')) && await js(`Boolean(${editor})`));
  fs.writeFileSync(file, '// restored\n');
  check('削除後に戻ったファイルを取り込む', await wait(async () => (await value()) === '// restored\n'));

  await edit('// saved on close\n');
  close();
  await wait(dialog);
  await choose('accept');
  check('保存して閉じると書き込み後にタブを閉じる', await wait(async () => !(await js(`Boolean(${editor})`))) && fs.readFileSync(file, 'utf8') === '// restored\n// saved on close\n');
  await js(`window.__terp.openFile(${JSON.stringify(image)}).then(() => true)`);
  check('画像は閲覧の表示のまま開く', await js(`Boolean(document.querySelector('.fileview:not([hidden]) .fileview__image')) && !window.__terp.editorOf(${JSON.stringify(image)})`));
}

// TERP_SELFTEST_AGENTS を付けると、AI エージェントの検出と起動のボタンを確かめる。
// 偽のエージェント（引数を表示するだけのスクリプト）を設定ファイルの agents に足して押す
async function runAgentsTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const fakeDir = prepareAgentFakes(outDir);
  const fake = path.join(outDir, 'fake agent');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(fake, '#!/bin/sh\necho "fake-agent-started $*"\nsleep 3\n', { mode: 0o755 });
  const commands = () => js(`[...document.querySelectorAll('#agents .btn--agent')].map((b) => b.dataset.command)`);

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config.agents = [
    { command: fake, label: 'Fake Agent', args: '--hello', bypassArgs: '--skip-checks' },
    { command: 'no-such-agent-cli', label: '入っていない' },
    { command: 'claude', path: path.join(fakeDir, 'claude') },
    { command: 'codex', path: path.join(fakeDir, 'codex') },
  ];
  config.skipApprovals = true;
  config.mainAgent = null;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  await sleep(1200);
  await js('window.__terp.refreshAgents()');
  const after = await commands();
  check('入っている claude と codex のボタンが出る', after.includes('claude') && after.includes('codex'), after.join(', '));
  check('設定ファイルに書いたエージェントが足される', after.includes(fake), after.join(', '));
  check('入っていないものは出ない', !after.includes('no-such-agent-cli'));

  const before = await js('window.__terp.activeId');
  const cwd = await js(`window.__terp.sessions.get(${before}).cwd`);
  await js(`[...document.querySelectorAll('#agents .btn--agent')].find((b) => b.dataset.command === ${JSON.stringify(fake)}).click()`);
  await sleep(2500);
  const id = await js('window.__terp.activeId');
  check('押すと新しいターミナルが開く', id !== before, `${before} → ${id}`);
  const text = await js(`window.__terp.bufferText(${id})`);
  check('空白を含むパスでも引数付きで起動する', /fake-agent-started --hello/.test(text), text.split('\n').slice(-1)[0]);
  check('普段は確認を飛ばす引数を付けて起動する', /fake-agent-started --hello --skip-checks/.test(text));
  const tag = await js(`!window.__terp.sessions.get(${id}).li.querySelector('.session__bypass').hidden`);
  check('確認なしのターミナルに印が付く', tag === true);
  const claudeTitle = await js(`document.querySelector('#agents [data-command="claude"]').title`);
  check('claude は Orca と同じ引数で確認を飛ばす', claudeTitle.includes('--dangerously-skip-permissions'), claudeTitle);

  // ⌥ を押しながら押すと、確認ありで起動する
  await js(`[...document.querySelectorAll('#agents .btn--agent')].find((b) => b.dataset.command === ${JSON.stringify(fake)}).dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))`);
  await sleep(2500);
  const altId = await js('window.__terp.activeId');
  const altText = await js(`window.__terp.bufferText(${altId})`);
  check('⌥ を押しながらだと確認ありで起動する', /fake-agent-started --hello$/m.test(altText) && !/--skip-checks\n?$/.test(altText.trim()), altText.split('\n').slice(-1)[0]);
  const altTag = await js(`window.__terp.sessions.get(${altId}).li.querySelector('.session__bypass').hidden`);
  check('確認ありのターミナルには印が付かない', altTag === true);
  const newCwd = await js(`window.__terp.sessions.get(${id}).cwd`);
  check('表示中と同じ作業場所で開く', newCwd === cwd, newCwd);

  // リポジトリが無いとフォルダを選ぶ画面が出るため、先に1つ足す
  const { execFileSync } = require('child_process');
  const repo = path.join(outDir, 'agents-repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
  await js('window.__terp.openWorkDialog()');
  await sleep(300);
  const options = await js(`[...document.querySelectorAll('#work-dialog [name=command] option')].map((o) => o.textContent)`);
  await js(`document.getElementById('work-dialog').close()`);
  check('新しい作業の画面の選択肢も揃う', options.includes('claude（確認なし）') && options.includes('codex（確認なし）') && options.at(-1) === '起動しない', options.join(', '));

  // タブの並びの隣の ＋: ターミナルと、見つかったエージェント全部が出る
  await js(`document.getElementById('tab-new').click()`);
  await sleep(300);
  const menu = await js(`[...document.querySelectorAll('#tab-menu .menu__item .menu__label')].map((l) => l.textContent)`);
  check('＋ のプルダウンにターミナルとエージェント全部が出る', menu[0] === 'ターミナル' && ['Claude Code', 'Codex', 'Fake Agent'].every((n) => menu.includes(n)), menu.join(', '));
  const tagged = await js(`document.querySelector('#tab-menu [data-command="claude"] .session__bypass')?.textContent || ''`);
  check('プルダウンに確認なしの印が出る', tagged === '確認なし');
  const countBefore = await js('window.__terp.sessions.size');
  await js(`[...document.querySelectorAll('#tab-menu .menu__item')].find((b) => b.dataset.command === ${JSON.stringify(fake)}).click()`);
  await sleep(2500);
  const menuId = await js('window.__terp.activeId');
  check('プルダウンで選ぶと起動する', (await js('window.__terp.sessions.size')) === countBefore + 1 && /fake-agent-started --hello --skip-checks/.test(await js(`window.__terp.bufferText(${menuId})`)));
  check('選んだらプルダウンが閉じる', await js(`document.getElementById('tab-menu').hidden`));

  // メインのエージェントのボタン: 既定は見つかった最初のもの。設定の mainAgent で変えられる
  check('メインのボタンは既定で最初のエージェント', (await js(`document.getElementById('tab-main-agent').dataset.command`)) === fake);
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.mainAgent = 'claude';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  await sleep(1500);
  check('設定の mainAgent でメインを変えられる', (await js(`document.getElementById('tab-main-agent').dataset.command`)) === 'claude');
  cfg.mainAgent = fake;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  await sleep(1500);
  await js(`document.getElementById('tab-main-agent').click()`);
  await sleep(2500);
  const mainId = await js('window.__terp.activeId');
  check('メインのボタンでプルダウンなしに起動する', mainId !== menuId && /fake-agent-started --hello --skip-checks/.test(await js(`window.__terp.bufferText(${mainId})`)));
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'agents-tabbar.png'), img.toPNG()));
  await js(`document.getElementById('tab-new').click()`);
  await sleep(300);
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'agents-menu.png'), img.toPNG()));
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
}

// TERP_SELFTEST_GIT を付けると、一時フォルダにプッシュ先の役の空のリポジトリと作業用の複製を作り、
// 「変更」の面のステージ・差分・コミット・プッシュ・プルを、画面のボタンを押して確かめる
async function runGitTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const base = path.join(outDir, 'git-test');
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  fs.mkdirSync(base, { recursive: true });
  sh(['init', '-q', '--bare', '-b', 'main', remote], base);
  for (const dir of [work, other]) {
    sh(['clone', '-q', remote, dir], base);
    sh(['config', 'user.name', 'test'], dir);
    sh(['config', 'user.email', 'test@example.com'], dir);
  }
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  sh(['add', '.'], work);
  sh(['commit', '-q', '-m', 'init'], work);
  sh(['push', '-q', '-u', 'origin', 'main'], work);

  const shot = (name) => win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()));
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
  const count = (group) => js(`document.querySelectorAll('[data-group="${group}"] .git__file').length`);
  const settle = async () => {
    await js(`document.getElementById('panel-refresh').click()`);
    await sleep(800);
  };

  await js(`window.__terp.open(${JSON.stringify(work)})`);
  await sleep(2500);
  await click('#git-toggle');
  await sleep(800);
  check('面にブランチが出る', (await text('#git-branch')) === 'main', await text('#git-branch'));
  check('面にコミットの名義が出る', (await text('#git-identity')).includes('test <test@example.com>'), await text('#git-identity'));

  fs.writeFileSync(path.join(work, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(work, 'b.txt'), 'new file\n');
  await settle();
  check('変更と追跡外のファイルが未ステージに出る', (await count('unstaged')) === 2, `件数 ${await count('unstaged')}`);
  check('上の帯のボタンに変更の数が出る', (await text('#git-toggle-count')) === '2', await text('#git-toggle-count'));

  await click('[data-group="unstaged"] .git__file');
  await sleep(800);
  const adds = await js(`document.querySelectorAll('#diff-body .diff__row--add').length`);
  const dels = await js(`document.querySelectorAll('#diff-body .diff__row--del').length`);
  check('差分に追加と削除の行が出る', adds === 2 && dels === 1, `追加 ${adds} / 削除 ${dels}`);
  await shot('1-diff');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  check('Esc で差分を閉じる', await js(`document.getElementById('diff-view').hidden`));

  await click('[data-action="stage-all"]');
  await sleep(800);
  check('すべてステージできる', (await count('staged')) === 2 && (await count('unstaged')) === 0);
  const disabled = await js(`document.querySelector('#git-commit [type="submit"]').disabled`);
  check('メッセージが無いとコミットできない', disabled && (await text('#git-commit-reason')).includes('メッセージ'), await text('#git-commit-reason'));
  await click('[data-group="staged"] .git__file .icon-btn');
  await sleep(800);
  check('1件をステージから外せる', (await count('staged')) === 1 && (await count('unstaged')) === 1);
  await click('[data-action="stage-all"]');
  await sleep(800);

  await js(`(() => { const t = document.querySelector('#git-commit textarea'); t.value = 'テストのコミット'; t.dispatchEvent(new Event('input')); })()`);
  await click('#git-commit [type="submit"]');
  await sleep(1500);
  check('コミットできる', sh(['log', '-1', '--format=%s'], work).trim() === 'テストのコミット');
  check('コミットしたら一覧が空になる', (await count('staged')) === 0 && (await count('unstaged')) === 0);
  check('変更が無いと「変更はありません」と出る', !(await js(`document.getElementById('git-clean').hidden`)));
  await settle();
  check('上流より1件進んでいると出る', (await text('#git-ab')).startsWith('↑1'), await text('#git-ab'));
  check('プッシュのボタンに送る件数が出る', (await text('#git-push')) === 'プッシュ ↑1', await text('#git-push'));
  await shot('2-committed');

  await click('#git-push');
  await sleep(3000);
  check('プッシュできる', sh(['log', '-1', '--format=%s', 'main'], remote).trim() === 'テストのコミット', await text('#git-result'));

  // 別の複製から1件送り、プルで取り込む
  sh(['pull', '-q'], other);
  fs.writeFileSync(path.join(other, 'c.txt'), 'from other\n');
  sh(['add', '.'], other);
  sh(['commit', '-q', '-m', 'other'], other);
  sh(['push', '-q'], other);
  await click('#git-pull');
  await sleep(3000);
  check('プルで取り込める', fs.existsSync(path.join(work, 'c.txt')), await text('#git-result'));

  // 新しいブランチは追跡先が無いため、プッシュで origin に作る
  sh(['switch', '-q', '-c', 'topic'], work);
  await settle();
  check('追跡先が無いと出る', (await text('#git-upstream')).includes('追跡先がありません'));
  await click('#git-push');
  await sleep(3000);
  check('追跡先の無いブランチもプッシュできる', sh(['branch', '--list', 'topic'], remote).includes('topic'), await text('#git-result'));
  await shot('3-pushed');
}

// TERP_SELFTEST_HISTORY は一時リポジトリだけにコミットし、履歴の閲覧を確かめる
// TERP_SELFTEST_WALLPAPER は、全画面に入ったときの壁紙を窓の後ろに敷くことを確かめる。
// 本物の全画面は Space を切り替えて利用者の画面を動かすため、全画面に入ったときと同じ合図を送って確かめる
// TERP_SELFTEST_SIDEBAR は、左の一覧を ⌘B とボタンで隠す・出すことと、その状態が tabs.json に残ることを確かめる
async function runSidebarTest({ win, js, check, outDir }) {
  const menu = async () => {
    const { Menu } = require('electron');
    const view = Menu.getApplicationMenu().items.find((item) => item.label === '表示');
    view.submenu.items.find((entry) => entry.accelerator === 'CmdOrCtrl+B').click();
    await sleep(400);
  };
  const state = () => js(`(() => {
    const term = window.__terp.sessions.get(window.__terp.activeId);
    return { hidden: getComputedStyle(document.getElementById('sidebar')).display === 'none',
      show: !document.getElementById('sidebar-show').hidden, cols: term.term.cols };
  })()`);
  await sleep(1000);
  const before = await state();
  check('初めは左の一覧が出ていて、出すボタンは無い', !before.hidden && !before.show);
  await menu();
  const hidden = await state();
  check('⌘B のメニューで左の一覧が隠れ、出すボタンが出る', hidden.hidden && hidden.show);
  check('隠すと端末の桁が増える', hidden.cols > before.cols, `${before.cols} → ${hidden.cols}`);
  await sleep(700);
  fs.writeFileSync(path.join(outDir, 'sidebar-hidden.png'), (await win.webContents.capturePage()).toPNG());
  await sleep(500);
  const saved = JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'tabs.json'), 'utf8'));
  check('隠した状態が tabs.json に残る', saved.sidebarHidden === true);
  await js(`document.getElementById('sidebar-show').click()`);
  await sleep(400);
  const shown = await state();
  check('出すボタンで左の一覧が戻り、ボタンは消える', !shown.hidden && !shown.show && shown.cols === before.cols);
  await js(`document.getElementById('sidebar-hide').click()`);
  await sleep(400);
  check('一覧の上のボタンでも隠せる', (await state()).hidden);
  await menu();
  check('もう一度 ⌘B で戻る', !(await state()).hidden);

  // 幅: 右端をドラッグして変え、tabs.json に残す。ダブルクリックで元に戻す
  const width = () => js(`Math.round(document.getElementById('sidebar').getBoundingClientRect().width)`);
  const base = await width();
  const edge = await js(`(() => { const r = document.getElementById('sidebar-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) }; })()`);
  // 窓を前に出さずに本物のマウスの操作を送るため、DevTools の入力を使う
  const cdp = win.webContents.debugger;
  if (!cdp.isAttached()) cdp.attach('1.3');
  const mouse = (type, x) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y: edge.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', edge.x);
  for (let x = edge.x; x <= edge.x + 120; x += 20) { await mouse('mouseMoved', x); await sleep(30); }
  await mouse('mouseReleased', edge.x + 120);
  cdp.detach();
  await sleep(600);
  const wide = await width();
  check('右端をドラッグすると左の一覧が広がる', Math.abs(wide - (base + 120)) <= 3, `${base} → ${wide}`);
  check('広げると端末の桁が減る', (await state()).cols < before.cols);
  const savedWidth = JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'tabs.json'), 'utf8')).sidebarWidth;
  check('幅が tabs.json に残る', Math.abs(savedWidth - wide) <= 1, String(savedWidth));
  await js(`window.__terp.setSidebarWidth(0)`);
  await sleep(300);
  check('狭めすぎない（200px まで）', (await js(`getComputedStyle(document.getElementById('sidebar')).width`)) === '200px');
  check('いちばん狭くしても、上端のボタンが一覧の中に収まる', await js(`(() => {
    const side = document.getElementById('sidebar').getBoundingClientRect();
    return [...document.querySelectorAll('.sidebar__head button, .sidebar__head .sidebar__title')].filter((el) => el.getClientRects().length)
      .every((el) => { const r = el.getBoundingClientRect(); return r.left >= 76 && r.right <= side.right; });
  })()`));
  fs.writeFileSync(path.join(outDir, 'sidebar-narrow.png'), (await win.webContents.capturePage()).toPNG());
  await js(`window.__terp.setSidebarWidth(9999)`);
  check('広げすぎない（520px まで）', (await js(`getComputedStyle(document.getElementById('sidebar')).width`)) === '520px');
  await js(`document.getElementById('sidebar-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  check('ダブルクリックで元の幅に戻る', (await width()) === base);
  // 幅に余裕があっても、リポジトリの見出しでは隠れたボタンが場所を取らない
  check('リポジトリの見出しで、隠れたボタンが場所を取らない', await js(`[...document.querySelectorAll('.project__head .icon-btn--hover:not([aria-pressed="true"])')].every((el) => el.getBoundingClientRect().width === 0)`));
}

// TERP_SELFTEST_SHORTCUTS は、VS Code に倣って足したキー（⌘F・⌘G、⌘= / ⌘- / ⌘0、⇧⌘T）を確かめる
async function runShortcutsTest({ win, js, check, outDir }) {
  const menu = async (label) => {
    const { Menu } = require('electron');
    const item = Menu.getApplicationMenu().items.flatMap((top) => top.submenu.items).find((entry) => entry.label === label && entry.visible);
    item.click();
    await sleep(400);
  };
  const waitFor = async (code, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  await sleep(1500);
  const id = await js('window.__terp.activeId');
  await js(`window.terp.write(${id}, 'echo FIND""ME1; echo FIND""ME2\\r')`);
  await waitFor(`window.__terp.bufferText(${id}).includes('FINDME2\\n')`);

  await menu('検索');
  const opened = await js(`(() => { const bar = document.getElementById('term-search');
    return { shown: !bar.hidden, focused: document.activeElement === bar.querySelector('input'),
      inPane: Boolean(bar.closest('.pane__body')) }; })()`);
  check('⌘F で検索欄が枠の中に出て、入力欄に文字を打てる', opened.shown && opened.focused && opened.inPane, JSON.stringify(opened));
  await js(`(() => { const input = document.querySelector('#term-search input'); input.value = 'FINDME'; input.dispatchEvent(new Event('input')); })()`);
  await sleep(500);
  const first = await js('window.__terp.termSearch.countText()');
  check('打った文字の当たりの数と位置が出る', /^\d+\/2$/.test(first), first);
  await menu('次を検索');
  const second = await js('window.__terp.termSearch.countText()');
  check('⌘G で次の当たりへ進む', /^\d+\/2$/.test(second) && second !== first, `${first} → ${second}`);
  check('当たりの文字が選ばれる', (await js(`window.__terp.sessions.get(${id}).term.getSelection()`)) === 'FINDME');
  await sleep(300);
  fs.writeFileSync(path.join(outDir, 'term-search.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#term-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(200);
  const closed = await js(`({ hidden: document.getElementById('term-search').hidden,
    termFocused: document.activeElement === window.__terp.sessions.get(${id}).term.textarea })`);
  check('Esc で検索欄が閉じ、端末に戻る', closed.hidden && closed.termFocused, JSON.stringify(closed));

  const font = () => js(`({ size: window.__terp.sessions.get(${id}).term.options.fontSize, cols: window.__terp.sessions.get(${id}).term.cols })`);
  const base = await font();
  await menu('文字を大きく');
  const bigger = await font();
  check('⌘= で文字が大きくなり、桁が減る', bigger.size === base.size + 1 && bigger.cols < base.cols, `${base.size}pt ${base.cols}桁 → ${bigger.size}pt ${bigger.cols}桁`);
  await menu('文字を小さく');
  await menu('文字を小さく');
  check('⌘- で文字が小さくなる', (await font()).size === base.size - 1);
  await sleep(500);
  const saved = JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'tabs.json'), 'utf8'));
  check('文字の大きさの差が tabs.json に残る', saved.fontDelta === -1, String(saved.fontDelta));
  await menu('新しいターミナル');
  check('後から開いた端末も同じ大きさになる', (await js('window.__terp.sessions.get(window.__terp.activeId).term.options.fontSize')) === base.size - 1);
  await menu('文字を元の大きさに');
  check('⌘0 で設定の大きさに戻る', (await font()).size === base.size);

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'terp-reopen-')));
  const second2 = await js('window.__terp.activeId');
  await js(`(() => { const s = window.__terp.sessions.get(${second2}); s.customName = 'REOPENME'; window.terp.setMeta(s.id, { customName: s.customName }); })()`);
  await js(`window.terp.write(${second2}, ${JSON.stringify(`cd ${dir}
`)})`);
  const moved = await waitFor(`window.__terp.sessions.get(${second2})?.cwd === ${JSON.stringify(dir)}`);
  check('試しの端末が試しの場所へ移る', moved);
  await menu('タブを閉じる');
  await waitFor(`!window.__terp.sessions.has(${second2})`);
  check('閉じた端末を覚える', (await js('window.__terp.closedTabs[0]?.name')) === 'REOPENME');
  await menu('閉じたタブを開き直す');
  const reopened = await waitFor(`(() => { const s = window.__terp.sessions.get(window.__terp.activeId);
    return s && s.id !== ${second2} && s.customName === 'REOPENME' && s.cwd === ${JSON.stringify(dir)}; })()`, 50);
  check('⇧⌘T で同じ名前・同じ場所の端末が開き、前に出る', reopened);
  check('開き直したものは覚えから消える', (await js('window.__terp.closedTabs.length')) === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// TERP_SELFTEST_LOCK は、枠の固定（VS Code のグループのロック）を確かめる。固定した枠はタブを切り替えても中身が変わらない
async function runLockTest({ win, js, check, outDir }) {
  const menu = async (label) => {
    const { Menu } = require('electron');
    Menu.getApplicationMenu().items.flatMap((top) => top.submenu.items).find((entry) => entry.label === label).click();
    await sleep(400);
  };
  const panes = () => js(`window.__terp.layout() && (() => { const list = []; const walk = (n) => n.type === 'pane' ? list.push(n) : n.children.forEach(walk); walk(window.__terp.layout()); return list; })()`);
  await sleep(1500);
  const t1 = await js('window.__terp.activeId');
  const t2 = await js('window.__terp.open()');
  const t3 = await js('window.__terp.open()');
  await js(`window.__terp.activateKey('t:${t1}')`);
  await menu('右に分割');
  await sleep(600);
  await js(`window.__terp.activateKey('t:${t1}')`);
  const left = (await panes()).find((p) => p.key === `t:${t1}`).id;
  await js(`document.querySelector('.pane[data-pane-id="${left}"] .pane__lock').click()`);
  await sleep(200);
  const locked = await js(`({ data: document.querySelector('.pane[data-pane-id="${left}"]').dataset.locked,
    pressed: document.querySelector('.pane[data-pane-id="${left}"] .pane__lock').getAttribute('aria-pressed') })`);
  check('錠のボタンで枠を固定できる', (await panes()).find((p) => p.id === left).locked === true && locked.data === 'true' && locked.pressed === 'true', JSON.stringify(locked));
  await js(`window.__terp.activateKey('t:${t2}')`);
  await sleep(300);
  let list = await panes();
  check('固定した枠でタブを切り替えると、中身は変わらず隣の枠に出る',
    list.find((p) => p.id === left).key === `t:${t1}` && list.find((p) => p.id !== left).key === `t:${t2}`, JSON.stringify(list));
  check('タブを出した枠に移る', (await js('window.__terp.activePaneId')) !== left);
  await sleep(300);
  fs.writeFileSync(path.join(outDir, 'pane-lock.png'), (await win.webContents.capturePage()).toPNG());
  await menu('今の枠を固定');
  await js(`window.__terp.activateKey('t:${t3}')`);
  await sleep(400);
  list = await panes();
  check('全部の枠が固定なら、枠を足して出す', list.length === 3 && list.some((p) => p.key === `t:${t1}`) && list.some((p) => p.key === `t:${t2}`) && list.some((p) => p.key === `t:${t3}` && !p.locked), JSON.stringify(list));
  check('すでに表示しているタブを選ぶと、その枠に移るだけ', await js(`(window.__terp.activateKey('t:${t1}'), window.__terp.activePaneId === ${JSON.stringify(left)})`));
  await sleep(600);
  const saved = JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'tabs.json'), 'utf8'));
  check('固定が tabs.json に残る', JSON.stringify(saved.layout).split('"locked":true').length - 1 === 2);
  await js(`document.querySelector('.pane[data-pane-id="${left}"] .pane__lock').click()`);
  await sleep(200);
  check('もう一度押すと固定が外れる', !(await panes()).find((p) => p.id === left).locked);
}

// TERP_SELFTEST_DRAFT は、左の一覧の「ドラフト」「すべて」を確かめる。ドラフトにはドラフトに入れたリポジトリとターミナルだけを出し、
// 「すべて」は追加したリポジトリの名前だけを並べて、押すとドラフトに出し入れする。外したターミナルは1行にまとまり、そこから戻せる
async function runDraftTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const { CONFIG_DIR } = require('./config');
  const wait = async (code, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-draft-')));
  const repos = ['repo-a', 'repo-b', 'repo-c'].map((name) => {
    const repo = path.join(dir, name);
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    return repo;
  });
  const [a, b, c] = repos;
  const q = (repo) => JSON.stringify(JSON.stringify(repo)).slice(1, -1);
  const section = (repo) => `document.querySelector('.project[data-path=${q(repo)}]')`;
  const shown = (id) => `window.__terp.sessions.get(${id}).li.isConnected`;
  const stored = () => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'projects.json'), 'utf8')).projects;
  try {
    await sleep(1000);
    for (const repo of repos) await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
    await wait(`window.__terp.projects.length === 3`);
    check('足したリポジトリはドラフトに入る', await wait(`Boolean(${section(a)} && ${section(b)} && ${section(c)})`) && stored().every((p) => p.draft === true));
    check('初めは「ドラフト」を開いている', await js(`window.__terp.sidebarView === 'draft' && document.querySelector('.sidebar-views__tab[data-view="draft"]').getAttribute('aria-selected') === 'true'`));
    const ta = await js(`window.__terp.open(${JSON.stringify(a)})`);
    const tb = await js(`window.__terp.open(${JSON.stringify(b)})`);
    await wait(`window.__terp.workOf(${tb}) === ${JSON.stringify(b)}`);
    await js(`window.__terp.activate(${ta})`);
    await js(`${section(b)}.querySelector('[data-action="draft"]').click()`);
    check('見出しの星でリポジトリをドラフトから外す', await wait(`!${section(b)} && !${shown(tb)}`));
    check('外したリポジトリのターミナルは「外したターミナル」の1行にまとまる', await wait(`!document.getElementById('draft-out').hidden && document.querySelector('.draft-out__count').textContent === '1'`));
    await sleep(300);
    check('ドラフトから外したことが projects.json に残る', stored().find((p) => p.path === b).draft === false);
    fs.writeFileSync(path.join(outDir, 'draft-view.png'), (await win.webContents.capturePage()).toPNG());

    await js(`document.querySelector('.sidebar-views__tab[data-view="all"]').click()`);
    await wait(`window.__terp.sidebarView === 'all'`);
    const all = await js(`({
      repos: [...document.querySelectorAll('#projects .project')].map((el) => el.dataset.path),
      sessions: document.querySelectorAll('#tree .session').length, works: document.querySelectorAll('#tree .work').length,
      draft: [...document.querySelectorAll('#projects .project__head')].map((el) => el.dataset.draft),
      out: !document.getElementById('draft-out').hidden,
      newTerminal: getComputedStyle(document.getElementById('new-terminal')).display, newWork: getComputedStyle(document.getElementById('new-work')).display,
      drafted: getComputedStyle(${section(a)}.querySelector('.project__head')).backgroundImage,
      plain: getComputedStyle(${section(b)}.querySelector('.project__head')).backgroundImage })`);
    check('「すべて」には追加したリポジトリを全部、名前だけで並べる', all.repos.join() === repos.join() && all.sessions === 0 && all.works === 0 && !all.out, JSON.stringify(all));
    check('「すべて」にはターミナルを開くボタンを出さない', all.newTerminal === 'none' && all.newWork === 'none', JSON.stringify(all));
    check('「すべて」ではドラフト済みのリポジトリを強調色のぼかしの背景にする', all.draft.join() === 'true,false,true' && all.drafted.startsWith('linear-gradient') && all.plain === 'none', JSON.stringify(all));
    await sleep(400);
    fs.writeFileSync(path.join(outDir, 'all-view.png'), (await win.webContents.capturePage()).toPNG());
    await js(`${section(b)}.querySelector('.project__head').click()`);
    check('「すべて」で名前を押すとドラフトに入る', await wait(`${section(b)}.querySelector('.project__head').dataset.draft === 'true'`) && (await sleep(300), stored().find((p) => p.path === b).draft === true));
    await js(`${section(b)}.querySelector('.project__head').click()`);
    check('もう一度押すとドラフトから外れる', await wait(`${section(b)}.querySelector('.project__head').dataset.draft === 'false'`));
    await sleep(400);
    check('表示中の面が tabs.json に残る', JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'tabs.json'), 'utf8')).sidebarView === 'all');

    const swipe = (dx) => js(`document.getElementById('tree').dispatchEvent(new WheelEvent('wheel', { deltaX: ${dx}, deltaY: 0, cancelable: true }))`);
    await sleep(300);
    await swipe(30);
    check('滑らせている間は一覧が指に合わせて動く', await js(`document.getElementById('tree').style.transform === 'translateX(-15px)' && window.__terp.sidebarView === 'all'`));
    await swipe(30);
    check('2本指で左へ滑らせると「ドラフト」に切り替わる', await wait(`window.__terp.sidebarView === 'draft' && !document.getElementById('tree').style.transform`));
    for (const dx of [30, 20, 12, 6]) await swipe(dx);
    check('指を離した後の慣性では切り替えない', await js(`window.__terp.sidebarView === 'draft'`));
    for (const dx of [-20, -40]) await swipe(dx);
    check('待たずに逆へ滑らせると、すぐに切り替え直す', await wait(`window.__terp.sidebarView === 'all'`));
    for (const dx of [-40, -20, -10]) await swipe(dx);
    for (const dx of [8, 20, 40]) await swipe(dx);
    check('慣性の途中でも、逆へ滑らせれば新しい滑らせとして受ける', await wait(`window.__terp.sidebarView === 'draft'`));
    await sleep(300);
    for (const dx of [-20, -20]) await swipe(dx);
    await sleep(300);
    check('切り替えに届かずに離すと元の位置へ戻る', await js(`window.__terp.sidebarView === 'draft' && !document.getElementById('tree').style.transform`));
    await swipe(-90);
    check('右へ滑らせると「すべて」に切り替わる', await wait(`window.__terp.sidebarView === 'all'`));
    await sleep(300);
    await js(`(() => { const tab = document.querySelector('.sidebar-views__tab[aria-selected="true"]'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); })()`);
    check('切り替えは ← → でもできる', await wait(`window.__terp.sidebarView === 'draft'`));

    await js(`window.__terp.activate(${ta})`);
    await js(`window.__terp.sessions.get(${ta}).li.querySelector('[data-action="draft"]').click()`);
    check('ターミナルの星でドラフトから外す（表示中でも消える）', await wait(`!${shown(ta)} && document.querySelector('.draft-out__count').textContent === '2'`));
    check('外したターミナルも上のタブには残る', await js(`window.__terp.tabOrder.includes('t:${ta}')`));
    await js(`document.getElementById('overview-open').click()`);
    await sleep(500);
    check('⌘M の一覧には外したターミナルも出る', await js(`Boolean(document.querySelector('.overview__tile[data-id="${ta}"]')) && Boolean(document.querySelector('.overview__tile[data-id="${tb}"]'))`));
    await js(`document.querySelector('#overview [data-close]').click()`);
    await sleep(300);
    await js(`document.getElementById('draft-out-open').click()`);
    await sleep(300);
    const items = await js(`[...document.querySelectorAll('.menu:popover-open .menu__item')].map((el) => el.textContent)`);
    check('「外したターミナル」を押すと、外したものが並ぶ', items.length === 2, JSON.stringify(items));
    await js(`document.querySelectorAll('.menu:popover-open .menu__item')[1].click()`);
    check('選ぶと、リポジトリごとドラフトに戻って表示する', await wait(`${shown(tb)} && Boolean(${section(b)}) && window.__terp.activeId === ${tb} && document.querySelector('.draft-out__count').textContent === '1'`));
    await js(`window.__terp.setSessionDraft(${ta}, true)`);
    await wait(`${shown(ta)} && document.getElementById('draft-out').hidden`);

    await js(`window.__terp.setProjectDraft(${JSON.stringify(c)}, false)`);
    await js(`window.__terp.setSidebarView('all')`);
    const tc = await js(`window.__terp.open(${JSON.stringify(c)})`);
    check('「すべて」を見ていてもターミナルはドラフトに開き、リポジトリもドラフトに入る', await wait(`window.__terp.sidebarView === 'draft' && ${shown(tc)} && window.__terp.projects.find((p) => p.path === ${JSON.stringify(c)}).draft`));

    for (const repo of repos) await js(`window.__terp.setProjectDraft(${JSON.stringify(repo)}, false)`);
    for (const id of [ta, tb, tc]) await js(`window.__terp.setSessionDraft(${id}, false)`);
    const ids = await js(`[...window.__terp.sessions.keys()]`);
    for (const id of ids) await js(`window.__terp.setSessionDraft(${id}, false)`);
    check('ドラフトが空なら、「すべて」への案内を出す', await wait(`!document.getElementById('draft-empty').hidden && document.querySelectorAll('#projects .project').length === 0`));
    await js(`document.querySelector('[data-show-view="all"]').click()`);
    check('案内のボタンで「すべて」を開く', await wait(`window.__terp.sidebarView === 'all' && document.getElementById('draft-empty').hidden`));
    await js(`window.__terp.setSidebarView('draft')`);
    for (const id of ids) await js(`window.__terp.setSessionDraft(${id}, true)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_DROPREPO は、Finder のフォルダを左の一覧に落としてリポジトリを足せることを確かめる。
// 合成した File には実パスが無いため、受け取りの見た目はイベントで、足す処理はパスを直接渡して確かめる
async function runDropRepoTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-droprepo-')));
  const repo = path.join(dir, 'drop-repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const plain = path.join(dir, 'plain-folder');
  fs.mkdirSync(plain);
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'x');
  const fire = (target, type, kind = 'file') => js(`(() => {
    const data = new DataTransfer();
    if (${JSON.stringify(kind)} === 'file') data.items.add(new File(['x'], 'folder'));
    else data.setData('text/x-terp-tab', 't:1');
    const event = new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: data });
    document.querySelector(${JSON.stringify(target)}).dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  const marked = () => js(`document.getElementById('sidebar').dataset.dropRepo === 'true'`);
  try {
    await sleep(1000);
    await fire('#tree', 'dragenter');
    const accepted = await fire('#tree', 'dragover');
    check('Finder のものを左の一覧に載せると、受け取れる印が出る', (await marked()) && accepted);
    check('印に一言を添える', (await js(`getComputedStyle(document.getElementById('sidebar'), '::after').content`)).includes('リポジトリを追加'));
    await sleep(200);
    fs.writeFileSync(path.join(outDir, 'drop-repo.png'), (await win.webContents.capturePage()).toPNG());
    await fire('#projects', 'dragenter');
    await fire('#tree', 'dragleave');
    check('一覧の中の別の場所へ動いても印は消えない', await marked());
    await fire('#projects', 'dragleave');
    check('一覧の外へ出ると印が消える', !(await marked()));
    await fire('#tree', 'dragenter', 'tab');
    check('タブなど terp の中のドラッグには印を出さない', !(await marked()));
    await fire('#tree', 'dragenter');
    await fire('#tree', 'drop');
    check('落とすと印が消える', !(await marked()));
    check('端末の枠には印を出さない（受けるのは左の一覧だけ）', !(await js(`(() => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'folder'));
      document.querySelector('.pane__body').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      return document.getElementById('sidebar').dataset.dropRepo === 'true';
    })()`)));

    await js(`window.__terp.addDroppedRepos([${JSON.stringify(path.join(repo, 'src'))}])`);
    check('リポジトリの中のフォルダを落とすと、リポジトリの一番上を足す', (await js('window.__terp.projects.map((p) => p.path)')).includes(repo));
    await js(`window.__terp.addDroppedRepos([${JSON.stringify(plain)}, ${JSON.stringify(file)}])`);
    const error = await js(`document.querySelector('.workspace-picker__error').textContent`);
    check('git でないフォルダとファイルは、足さずに理由を出す', error.includes('git のリポジトリではありません') && error.includes('フォルダではないため追加できない: note.txt')
      && !(await js('window.__terp.projects.some((p) => p.path === ' + JSON.stringify(plain) + ')')), error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_NEWREPO は、その他のターミナルの作業場所に後から git の管理が始まったフォルダを見つけ、
// 端末をそこへまとめる案内を出すことを確かめる（ルートで claude を立ち上げて新しいプロジェクトを作る使い方）
async function runNewRepoTest({ win, js, check, outDir }) {
  const wait = async (code, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-newrepo-')));
  fs.mkdirSync(path.join(dir, 'before', '.git'), { recursive: true });
  try {
    await sleep(500);
    const id = await js(`window.__terp.open(${JSON.stringify(dir)})`);
    await wait(`window.__terp.sessions.get(${id}).cwd === ${JSON.stringify(dir)}`);
    await sleep(300);
    await js(`window.terp.write(${id}, 'mkdir fresh-app && git -C fresh-app init -q && echo NEWREPO-DONE\\r')`);
    await wait(`window.__terp.bufferText(${id}).includes('NEWREPO-DONE\\n')`);
    await js('window.__terp.scanNewRepos()');
    const shown = await wait(`!document.getElementById('repo-toast').hidden`, 30);
    const text = await js(`document.getElementById('repo-toast').innerText`);
    check('git の管理が始まると、端末をまとめるか尋ねる', shown && text.includes('fresh-app が git の管理を始めました') && text.includes('fresh-app にまとめる') && text.includes('今はしない'), text);
    check('端末を開く前からあったリポジトリは尋ねない', !text.includes('before') && await js(`window.__terp.repoOffer?.path === ${JSON.stringify(path.join(dir, 'fresh-app'))}`));
    fs.writeFileSync(path.join(outDir, 'repo-toast.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#repo-toast [data-action="accept"]').click()`);
    const moved = await wait(`window.__terp.workOf(${id}) === ${JSON.stringify(path.join(dir, 'fresh-app'))}`);
    check('まとめると、リポジトリを登録して端末をその下へ移す', moved && await js(`window.__terp.projects.some((p) => p.path === ${JSON.stringify(path.join(dir, 'fresh-app'))})
      && Boolean(document.querySelector('.project[data-path="${path.join(dir, 'fresh-app')}"] .session[data-id="${id}"], .project[data-path="${path.join(dir, 'fresh-app')}"] [data-id="${id}"]'))`));
    check('端末は閉じず、シェルはそのまま続く', await js(`window.__terp.sessions.has(${id}) && window.__terp.sessions.get(${id}).cwd === ${JSON.stringify(dir)}`));
    check('案内は閉じる', await js(`document.getElementById('repo-toast').hidden`));
    await sleep(1200);
    const snap = JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'sessions.json'), 'utf8'));
    check('まとめ先が控えに残る', snap.sessions.some((s) => s.id === id && s.workPath === path.join(dir, 'fresh-app')), JSON.stringify(snap.sessions.map((s) => s.workPath)));

    const other = await js(`window.__terp.open(${JSON.stringify(dir)})`);
    await wait(`window.__terp.sessions.get(${other}).cwd === ${JSON.stringify(dir)}`);
    await sleep(300);
    await js(`window.terp.write(${other}, 'mkdir later-app && git -C later-app init -q && echo LATER-DONE\\r')`);
    await wait(`window.__terp.bufferText(${other}).includes('LATER-DONE\\n')`);
    await js('window.__terp.scanNewRepos()');
    await wait(`window.__terp.repoOffer?.path === ${JSON.stringify(path.join(dir, 'later-app'))}`, 60);
    await js(`document.querySelector('#repo-toast [data-action="dismiss"]').click()`);
    await js('window.__terp.scanNewRepos()');
    await sleep(500);
    const before = await js('window.__terp.projects.length');
    await js(`window.__terp.openSettings('notifications')`);
    await sleep(500);
    await js(`[...document.querySelectorAll('#settings button')].find((el) => el.textContent === '新しいリポジトリの案内を試しに出す')?.click()`);
    await wait(`!document.getElementById('repo-toast').hidden`, 30);
    const sampleText = await js(`document.getElementById('repo-toast').innerText`);
    check('設定の通知から案内を試しに出せる', sampleText.includes('sample-app が git の管理を始めました') && sampleText.includes('試しの案内'), sampleText);
    await js(`document.querySelector('#repo-toast [data-action="accept"]').click()`);
    await sleep(500);
    check('試しの案内は、まとめるを押しても何も登録しない', await js(`document.getElementById('repo-toast').hidden && window.__terp.projects.length === ${before}`));
    check('今はしないを押すと、登録せず聞き直さない', await js(`document.getElementById('repo-toast').hidden
      && !window.__terp.projects.some((p) => p.path === ${JSON.stringify(path.join(dir, 'later-app'))}) && window.__terp.workOf(${other}) === null`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_COMMANDS は、設定で決めたコマンドがタブの ＋ のプルダウンに出て、選ぶと新しいターミナルで打たれること、
// 設定の「コマンド」で足す・並べ替える・消すと設定ファイルに残ることを確かめる
async function runCommandsTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const wait = async (code, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).commands;
  const menuLabels = `[...document.querySelectorAll('#tab-menu .menu__item .menu__label')].map((l) => l.textContent)`;
  const openMenu = async () => {
    if (!(await js(`document.getElementById('tab-menu').hidden`))) await js(`document.getElementById('tab-new').click()`);
    await js(`document.getElementById('tab-new').click()`);
    await sleep(200);
  };
  await sleep(500);
  await openMenu();
  check('登録が無いときは、プルダウンに登録の入口だけ出る', (await js(menuLabels)).at(-1) === 'コマンドを登録' && !(await js(`Boolean(document.querySelector('#tab-menu [data-user-command]'))`)), (await js(menuLabels)).join(', '));
  await js(`document.getElementById('tab-new').click()`);
  const res = await js(`window.terp.updateConfig({ commands: [{ label: 'あいさつ', command: 'echo USERCMD-$((40+2))' }] })`);
  check('設定にコマンドを書ける', res.ok, res.error);
  const bad = await js(`window.terp.updateConfig({ commands: [{ label: '', command: 'ls' }] })`);
  check('表示名の無いコマンドは書かない', !bad.ok && saved().length === 1, bad.error);
  await sleep(1200);
  await openMenu();
  const labels = await js(menuLabels);
  check('プルダウンにコマンドと編集の入口が出る', labels.at(-2) === 'あいさつ' && labels.at(-1) === 'コマンドを編集' && labels[0] === 'ターミナル', labels.join(', '));
  check('エージェントとコマンドの間を線で分ける', await js(`document.querySelector('#tab-menu [data-user-command]').previousElementSibling.classList.contains('menu__sep')`));
  fs.writeFileSync(path.join(outDir, 'commands-menu.png'), (await win.webContents.capturePage()).toPNG());
  const before = await js('window.__terp.sessions.size');
  await js(`document.querySelector('#tab-menu [data-user-command]').click()`);
  const ran = await wait(`window.__terp.sessions.size === ${before + 1} && window.__terp.bufferText(window.__terp.activeId).includes('USERCMD-42')`);
  check('選ぶと新しいターミナルでコマンドを打つ', ran, await js('window.__terp.bufferText(window.__terp.activeId)'));
  check('選んだらプルダウンが閉じる', await js(`document.getElementById('tab-menu').hidden`));

  await openMenu();
  await js(`[...document.querySelectorAll('#tab-menu .menu__item')].find((b) => b.textContent.includes('コマンドを編集')).click()`);
  check('編集の入口で設定のコマンドの画面が開く', await wait(`!document.getElementById('settings').hidden && document.querySelector('.settings__title')?.textContent === 'コマンド' && document.querySelectorAll('.command-list__row').length === 1`));
  const fill = (index, key, value) => js(`(() => {
    const input = document.querySelectorAll('.command-list__row')[${index}].querySelector('[data-command-field="${key}"]');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  })()`);
  const draft = (key, value) => js(`(() => {
    const input = document.querySelector('.command-list__draft [data-new-field="${key}"]');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input'));
  })()`);
  check('ボタンを押さなくても、新しいコマンドの入力欄が出ている', await js(`document.querySelectorAll('.command-list__draft input').length === 2 && !document.querySelector('.command-list__draft').hidden`));
  await draft('label', '一覧');
  await js(`document.querySelector('.command-list__draft [data-action="add"]').click()`);
  await sleep(500);
  check('コマンドが空なら登録しない', saved().length === 1 && await js(`document.querySelectorAll('.command-list__row').length === 1 && document.getElementById('settings-status').dataset.tone === 'error'`));
  await draft('command', 'ls -la');
  await js(`document.querySelector('.command-list__draft [data-new-field="command"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(500);
  check('Enter で登録すると一覧に足し、入力欄を空にする', await js(`document.querySelectorAll('.command-list__row').length === 2 && [...document.querySelectorAll('.command-list__draft input')].every((el) => el.value === '')`));
  check('名前とコマンドを入れると保存する', JSON.stringify(saved()) === JSON.stringify([{ label: 'あいさつ', command: 'echo USERCMD-$((40+2))' }, { label: '一覧', command: 'ls -la' }]), JSON.stringify(saved()));
  fs.writeFileSync(path.join(outDir, 'commands-settings.png'), (await win.webContents.capturePage()).toPNG());
  check('新しいコマンドの欄は、登録済みの行と入力欄の幅が揃う', await js(`(() => {
    const row = [...document.querySelector('.command-list__row').querySelectorAll('input')].map((el) => el.getBoundingClientRect());
    const draft = [...document.querySelectorAll('.command-list__draft input')].map((el) => el.getBoundingClientRect());
    return row.every((r, i) => Math.abs(r.left - draft[i].left) < 1 && Math.abs(r.width - draft[i].width) < 1);
  })()`));
  check('入力欄のプレースホルダーに欄の名前を出す', await js(`[...document.querySelectorAll('.command-list__row input')].slice(0, 2).map((el) => el.placeholder).join() === '表示名,コマンド'`));
  await js(`document.querySelectorAll('.command-list__row')[1].querySelector('[data-action="up"]').click()`);
  await sleep(500);
  check('並べ替えると設定の順も変わる', saved().map((c) => c.label).join(',') === '一覧,あいさつ');
  await js(`document.querySelectorAll('.command-list__row')[0].querySelector('[data-action="remove"]').click()`);
  await sleep(500);
  check('消すと設定からも消える', saved().map((c) => c.label).join(',') === 'あいさつ');
  await js(`document.querySelector('.command-list__row [data-action="remove"]').click()`);
  await sleep(500);
  check('全部消すと設定の項目ごと消える', !('commands' in JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))) && await js(`!document.querySelector('.command-list__empty').hidden`));
  await js(`document.getElementById('settings-close').click()`);
}

// TERP_SELFTEST_AGENTHISTORY は、AI エージェントの会話を履歴に残し、⌘M の一覧の右の列から再開できることを確かめる。
// 本物の claude・codex は動かさない。会話の ID は main に見つけたことにさせ、再開のコマンドは偽の実行ファイルで受ける
async function runAgentHistoryTest({ win, js, check, outDir }) {
  const { CONFIG_DIR } = require('./config');
  const wait = async (code, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-agenthistory-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "FAKE-${name.toUpperCase()} $*"\n`, { mode: 0o755 });
  }
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const claudeId = '11111111-2222-4333-8444-555555555555';
  const codexId = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const historyFile = path.join(CONFIG_DIR, 'agent-history.json');
  const stored = () => { try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries; } catch { return []; } };
  const items = `[...document.querySelectorAll('.overview__history-item')].map((li) => ({ agent: li.dataset.agent, name: li.querySelector('.overview__history-name').textContent, meta: li.querySelector('.overview__history-meta').textContent, live: !li.querySelector('.overview__history-live').hidden }))`;
  const openOverview = async () => {
    await js(`window.__terp.overview.open || window.__terp.overview.toggle()`);
    await sleep(400);
  };
  try {
    await sleep(800);
    const res = await js(`window.terp.updateConfig({ agents: [{ command: 'claude', path: ${JSON.stringify(path.join(bin, 'claude'))} }, { command: 'codex', path: ${JSON.stringify(path.join(bin, 'codex'))} }] })`);
    check('偽の claude・codex を設定に書ける', res.ok, res.error);
    await sleep(1200);
    await openOverview();
    check('履歴が無いときは、右の列に案内を出す', await js(`!document.querySelector('.overview__history-empty').hidden && document.querySelector('.overview__history-empty').textContent.startsWith('まだ履歴はない')`));
    await js(`window.__terp.overview.close()`);

    const a = await js(`window.__terp.open(${JSON.stringify(work)})`);
    const b = await js(`window.__terp.open(${JSON.stringify(work)})`);
    await js(`window.terp.setMeta(${a}, { agentTitle: 'ログインの不具合を調べる' }); window.terp.setMeta(${b}, { customName: 'codex の作業' })`);
    await js(`window.terp.setAgentHistoryTestSessions({ ${a}: { agent: 'claude', sessionId: '${claudeId}' }, ${b}: { agent: 'codex', sessionId: '${codexId}' } })`);
    const saved = stored();
    check('動いている会話が agent-history.json に残る', saved.length === 2 && saved.some((e) => e.agent === 'claude' && e.sessionId === claudeId && e.title === 'ログインの不具合を調べる' && e.cwd === work)
      && saved.some((e) => e.agent === 'codex' && e.sessionId === codexId && e.name === 'codex の作業'), JSON.stringify(saved));
    await js(`window.terp.setAgentHistoryTestSessions({ ${a}: { agent: 'claude', sessionId: '${claudeId}' }, ${b}: { agent: 'codex', sessionId: '${codexId}' } })`);
    check('同じ会話は1件にまとめる', stored().length === 2);

    await openOverview();
    await wait(`document.querySelectorAll('.overview__history-item').length === 2`);
    const list = await js(items);
    check('⌘M の一覧の右に履歴が出る', list.length === 2 && list.every((item) => item.live)
      && list.some((item) => item.name === 'ログインの不具合を調べる' && item.meta.startsWith('claude · ')) && list.some((item) => item.name === 'codex の作業'), JSON.stringify(list));
    const layout = await js(`(() => {
      const history = document.querySelector('.overview__history').getBoundingClientRect();
      const tiles = document.querySelector('.overview__list').getBoundingClientRect();
      return { right: history.left >= tiles.right - 1 && history.right <= window.innerWidth + 1, width: Math.round(history.width) };
    })()`);
    check('履歴の列はタイルの右に並ぶ', layout.right && layout.width > 200, JSON.stringify(layout));
    fs.writeFileSync(path.join(outDir, 'agent-history.png'), (await win.webContents.capturePage()).toPNG());
    await js(`(() => { const input = document.getElementById('overview-query'); input.value = 'ログイン'; input.dispatchEvent(new Event('input')); })()`);
    check('絞り込みの文字で履歴も絞る', await wait(`document.querySelectorAll('.overview__history-item').length === 1`));
    await js(`(() => { const input = document.getElementById('overview-query'); input.value = ''; input.dispatchEvent(new Event('input')); })()`);
    await wait(`document.querySelectorAll('.overview__history-item').length === 2`);
    await js(`window.__terp.activate(${b})`);
    await js(`document.querySelector('.overview__history-item[data-agent="claude"] .overview__history-open').click()`);
    check('開いている会話を選ぶと、そのターミナルへ移る', await wait(`!window.__terp.overview.open && window.__terp.activeId === ${a}`));

    // ターミナルを閉じた後は、新しいターミナルで再開する
    await js(`window.terp.setAgentHistoryTestSessions({ ${b}: { agent: 'codex', sessionId: '${codexId}' } })`);
    await js(`window.__terp.closeKey('t:${a}')`);
    await wait(`!window.__terp.sessions.has(${a})`);
    await openOverview();
    await wait(`document.querySelectorAll('.overview__history-item').length === 2`);
    check('閉じた会話は「開いている」が消える', !(await js(items)).find((item) => item.agent === 'claude').live);
    const before = await js('window.__terp.sessions.size');
    await js(`document.querySelector('.overview__history-item[data-agent="claude"] .overview__history-open').click()`);
    const resumed = await wait(`window.__terp.sessions.size === ${before + 1} && window.__terp.bufferText(window.__terp.activeId).includes('FAKE-CLAUDE --resume ${claudeId}')`);
    check('閉じた会話は、同じ場所の新しいターミナルで claude --resume する', resumed, await js('window.__terp.bufferText(window.__terp.activeId)'));
    check('再開したターミナルの作業場所は会話の場所', await wait(`window.__terp.sessions.get(window.__terp.activeId).cwd === ${JSON.stringify(work)}`));
    await js(`window.terp.setAgentHistoryTestSessions({})`);
    await openOverview();
    await wait(`document.querySelectorAll('.overview__history-item').length === 2`);
    await js(`window.__terp.closeKey('t:${b}')`);
    await wait(`!window.__terp.sessions.has(${b})`);
    await sleep(600);
    await js(`document.querySelector('.overview__history-item[data-agent="codex"] .overview__history-open').click()`);
    check('codex は codex resume で再開する', await wait(`window.__terp.bufferText(window.__terp.activeId).includes('FAKE-CODEX resume ${codexId}')`), await js('window.__terp.bufferText(window.__terp.activeId)'));

    await openOverview();
    await wait(`document.querySelectorAll('.overview__history-item').length === 2`);
    await js(`document.querySelector('.overview__history-item[data-agent="codex"] .overview__history-remove').click()`);
    await sleep(500);
    check('× で履歴から消える', (await js(items)).length === 1 && stored().length === 1 && stored()[0].agent === 'claude');
    await js(`window.__terp.overview.close()`);
  } finally {
    await js(`window.terp.setAgentHistoryTestSessions(null)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_MDPREVIEW は、Markdown のファイルを編集とプレビューで切り替えられることを確かめる
async function runMarkdownPreviewTest({ win, js, check, outDir }) {
  const wait = async (code, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-mdpreview-')));
  fs.mkdirSync(path.join(dir, 'docs'));
  // 1x1 の赤い PNG
  fs.writeFileSync(path.join(dir, 'docs', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(dir, 'docs', 'other.md'), '# 別の資料\n');
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, [
    '# 見出し', '', '本文の**太字**と`コード`。', '', '## 使い方', '', '- 一つ目', '- [x] 済んだこと', '',
    '| 列 | 値 |', '| --- | --- |', '| a | 1 |', '', '```js', 'const x = 1;', '```', '',
    '[使い方へ](#使い方) [別の資料](docs/other.md) [外のページ](https://example.com/)', '',
    '![点](docs/dot.png)', '', '<script>window.__mdInjected = true</script>', '<img src="x" onerror="window.__mdInjected = true">', '',
  ].join('\n'));
  const plain = path.join(dir, 'notes.txt');
  fs.writeFileSync(plain, 'text\n');
  const view = (file) => `[...document.querySelectorAll('.fileview')].find((el) => el.querySelector('.fileview__title').title === ${JSON.stringify(file)})`;
  const toggle = (file) => `${view(file)}.querySelector('.fileview__preview-toggle')`;
  const previewEl = (file) => `${view(file)}?.querySelector('.fileview__preview')`;
  try {
    await sleep(800);
    await js(`window.__terp.openFile(${JSON.stringify(plain)})`);
    check('Markdown 以外にはプレビューのボタンを出さない', await wait(`Boolean(${view(plain)}) && !${toggle(plain)}`));
    await js(`window.__terp.openFile(${JSON.stringify(readme)})`);
    await wait(`Boolean(${view(readme)}) && Boolean(window.__terp.editorOf(${JSON.stringify(readme)}))`);
    check('Markdown は初めはエディタで開き、プレビューのボタンを出す', await js(`${toggle(readme)}.textContent === 'プレビュー' && ${previewEl(readme)}.hidden`));
    await js(`${toggle(readme)}.click()`);
    check('ボタンでプレビューに切り替わる', await wait(`!${previewEl(readme)}.hidden && ${view(readme)}.querySelector('.fileview__editor').hidden && ${toggle(readme)}.textContent === '編集'`));
    const rendered = await js(`(() => {
      const p = ${previewEl(readme)};
      return { h1: p.querySelector('h1')?.textContent, h2id: p.querySelector('h2')?.id, strong: p.querySelector('strong')?.textContent,
        table: p.querySelectorAll('td').length, code: p.querySelector('pre code')?.textContent, task: p.querySelector('input[type=checkbox]')?.disabled,
        script: Boolean(p.querySelector('script')), onerror: [...p.querySelectorAll('img')].some((img) => img.hasAttribute('onerror')) };
    })()`);
    check('見出し・太字・表・コード・チェックの項目を描く', rendered.h1 === '見出し' && rendered.strong === '太字' && rendered.table === 2 && rendered.code === 'const x = 1;\n' && rendered.task === true, JSON.stringify(rendered));
    check('スクリプトと on* 属性は取り除く', !rendered.script && !rendered.onerror && !(await js('Boolean(window.__mdInjected)')), JSON.stringify(rendered));
    check('相対パスの画像を Markdown の場所から読む', await wait(`(() => { const img = ${previewEl(readme)}.querySelector('img[alt="点"]'); return img && img.complete && img.naturalWidth === 1; })()`));
    check('見出しに GitHub と同じ形の id を付ける', rendered.h2id === '使い方', rendered.h2id);
    fs.writeFileSync(path.join(outDir, 'markdown-preview.png'), (await win.webContents.capturePage()).toPNG());
    await js(`[...${previewEl(readme)}.querySelectorAll('a')].find((a) => a.textContent === '別の資料').click()`);
    check('相対パスのリンクは terp のタブで開く', await wait(`window.__terp.activeKey === ${JSON.stringify('f:' + path.join(dir, 'docs', 'other.md'))}`));
    check('前に選んだプレビューで次の Markdown も開く', await wait(`${previewEl(path.join(dir, 'docs', 'other.md'))}?.hidden === false && ${previewEl(path.join(dir, 'docs', 'other.md'))}.querySelector('h1')?.textContent === '別の資料'`));
    await js(`window.__terp.activateKey(${JSON.stringify('f:' + readme)})`);
    await sleep(300);
    await js(`(() => { const e = new KeyboardEvent('keydown', { key: 'V', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }); ${previewEl(readme)}.dispatchEvent(e); })()`);
    check('⇧⌘V でエディタに戻る', await wait(`${previewEl(readme)}.hidden && !${view(readme)}.querySelector('.fileview__editor').hidden`));
    await js(`window.__terp.editorOf(${JSON.stringify(readme)}).setValue('# 保存前の見出し\\n')`);
    await js(`(() => { const e = new KeyboardEvent('keydown', { key: 'v', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }); ${view(readme)}.querySelector('.fileview__editor textarea, .fileview__editor').dispatchEvent(e); })()`);
    check('エディタの中でも ⇧⌘V で切り替わり、保存前の内容をプレビューする', await wait(`!${previewEl(readme)}.hidden && ${previewEl(readme)}.querySelector('h1')?.textContent === '保存前の見出し'`));
    check('プレビューにしても未保存の変更は残る', await js(`window.__terp.editorOf(${JSON.stringify(readme)}).getValue() === '# 保存前の見出し\\n'`));
    await js(`${toggle(readme)}.click()`);
    await wait(`${previewEl(readme)}.hidden`);
    // 終わるときに保存の確認が出ないよう、元の内容に戻す
    await js(`window.__terp.editorOf(${JSON.stringify(readme)}).setValue(${JSON.stringify(fs.readFileSync(readme, 'utf8'))})`);
  } finally {
    await js(`(() => { try { localStorage.removeItem('terp.markdownPreview'); } catch {} })()`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_KEYS は、行の編集のキー（⌥←→・⌘←→・⌘⌫）と Shift+Enter が zsh で効くことを確かめる
async function runKeysTest({ win, js, check }) {
  const id = await js('window.__terp.activeId');
  const key = (k, mods) => js(`window.__terp.sessions.get(${id}).term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`);
  const type = (text) => js(`window.terp.write(${id}, ${JSON.stringify(text)})`);
  const line = async () => {
    await sleep(400);
    return js(`window.__terp.bufferText(${id}).trimEnd().split('\\n').at(-1)`);
  };
  await sleep(1500);
  await type('echo abc def');
  await key('ArrowLeft', { altKey: true });
  await type('X');
  check('⌥← で1語戻る', (await line()).endsWith('echo abc Xdef'), await line());
  await key('ArrowRight', { altKey: true });
  await type('Y');
  check('⌥→ で1語進む', (await line()).endsWith('echo abc XdefY'), await line());
  await key('ArrowLeft', { metaKey: true });
  await type('Z');
  check('⌘← で行の頭へ', (await line()).endsWith('Zecho abc XdefY'), await line());
  await key('ArrowRight', { metaKey: true });
  await type('W');
  check('⌘→ で行の末尾へ', (await line()).endsWith('Zecho abc XdefYW'), await line());
  await key('Backspace', { metaKey: true });
  check('⌘⌫ で行の頭まで消す', /[%$#] ?$/.test(await line()), await line());
  await type('echo q');
  await key('ArrowLeft', { ctrlKey: true });
  await type('R');
  check('⌃← は xterm の既定のまま（単語の移動に変えない）', !(await line()).endsWith('echo Rq'), await line());
  await type('\x15');
  // Shift+Enter は本物の押下（keydown の後に keypress も来る）で確かめる。
  // keypress まで端末に渡ると CR も送ってしまい、改行ではなく実行になる
  await js(`window.__terp.sessions.get(${id}).term.focus()`);
  await type('echo SHIFTENTER1');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
  await type('echo SHIFTENTER2');
  await sleep(600);
  const lines = (await js(`window.__terp.bufferText(${id})`)).split('\n').map((l) => l.trim());
  check('Shift+Enter は実行せず改行を入れる', !lines.includes('SHIFTENTER1') && lines.some((l) => l.endsWith('echo SHIFTENTER2')), lines.slice(-4).join(' | '));
  await type('\x03');
}

async function runWallpaperTest({ win, js, check, outDir }) {
  const wait = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return true;
      await sleep(50);
    }
    return false;
  };
  const visible = "(() => { const el = document.getElementById('wallpaper'); return !el.hidden && getComputedStyle(el).backgroundImage.startsWith('url(\"data:image/jpeg'); })()";
  await js(`window.terp.updateConfig({ backgroundOpacity: 0.6, backgroundBlur: 10 })`);
  await wait('window.__terp.config.window.opacity === 0.6');
  const url = await require('./wallpaper').wallpaperDataUrl(win.getBounds());
  check('いまの壁紙を JPEG にして読める', url.startsWith('data:image/jpeg;base64,') && url.length > 1000);
  win.webContents.send('fullscreen:wallpaper', url);
  check('全画面に入ると壁紙を後ろに敷く', await wait(visible));
  check('壁紙に窓と同じぼかしを掛ける', await js("getComputedStyle(document.getElementById('wallpaper')).filter === 'blur(10px)'"));
  await sleep(700);
  fs.writeFileSync(path.join(outDir, 'wallpaper.png'), (await win.webContents.capturePage()).toPNG());
  await js(`window.terp.updateConfig({ backgroundOpacity: null })`);
  check('不透明にすると壁紙を出さない', await wait("document.getElementById('wallpaper').hidden"));
  await js(`window.terp.updateConfig({ backgroundOpacity: 0.6 })`);
  check('透過に戻すと壁紙を出し直す', await wait(visible));
  win.webContents.send('fullscreen:wallpaper', null);
  check('全画面を出ると壁紙を外す', await wait("document.getElementById('wallpaper').hidden"));
  await js(`window.terp.updateConfig({ backgroundOpacity: null, backgroundBlur: null })`);
}

async function runHistoryTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const sh = (args, cwd) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(outDir), 'history-')));
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  sh(['init', '-q', '--bare', '-b', 'main', remote], base);
  sh(['clone', '-q', remote, work], base);
  sh(['config', 'user.name', 'test'], work);
  sh(['config', 'user.email', 'test@example.com'], work);
  const commit = (subject, body) => {
    sh(['add', '.'], work);
    sh(['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], work);
    return sh(['rev-parse', 'HEAD'], work);
  };
  fs.writeFileSync(path.join(work, 'a.txt'), '初期\n');
  const root = commit('最初のコミット');
  sh(['switch', '-q', '-c', 'topic'], work);
  fs.writeFileSync(path.join(work, 'topic.txt'), '枝の変更\n');
  commit('枝のコミット');
  sh(['switch', '-q', 'main'], work);
  for (let n = 0; n < 120; n++) {
    fs.writeFileSync(path.join(work, 'a.txt'), `更新 ${n}\n`);
    commit(`更新 ${String(n).padStart(3, '0')}`);
  }
  sh(['merge', '-q', '--no-ff', 'topic', '-m', '枝をマージ'], work);
  const merge = sh(['rev-parse', 'HEAD'], work);
  sh(['tag', 'history-tag'], work);
  sh(['switch', '-q', '-c', 'unmerged', root], work);
  fs.writeFileSync(path.join(work, 'unmerged.txt'), '未マージ\n');
  const unmerged = commit('未マージのコミット');
  sh(['switch', '-q', 'main'], work);
  sh(['push', '-q', '-u', 'origin', 'main'], work);
  sh(['switch', '-q', '-c', 'current'], work);
  sh(['branch', '--set-upstream-to=origin/main'], work);
  fs.writeFileSync(path.join(work, 'a.txt'), '未プッシュ 1\n');
  const parent = commit('未プッシュ 1');
  fs.writeFileSync(path.join(work, 'a.txt'), '未プッシュ 2\n');
  const head = commit('feat: 未プッシュ 2', '詳細の本文\n\n2段落目');
  const total = Number(sh(['rev-list', '--count', 'HEAD'], work));
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = async (code) => {
    for (let n = 0; n < 200; n++) {
      if (await js(code)) return true;
      await sleep(50);
    }
    throw new Error(`履歴の待機が期限切れ: ${code}`);
  };
  const ready = () => wait(`document.querySelector('#history-status').textContent === '' && !document.querySelector('#history-more').disabled`);
  const rows = () => js(`[...document.querySelectorAll('#history-list [data-hash]')].map((r) => r.dataset.hash)`);
  const search = async (text) => {
    await js(`(() => { const q = document.querySelector('#history-query'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`);
    await sleep(350);
    await ready();
  };
  const terminal = await js(`window.__terp.open(${JSON.stringify(work)})`);
  win.webContents.send('menu', 'toggle-history');
  await ready();
  check('履歴を開くと最初の100件が出る', (await rows()).length === 100);
  check('各コミットは30px未満の1行で、SVGの線の図を持つ', await js(`[...document.querySelectorAll('#history-list [data-hash]')].every((r) => r.getBoundingClientRect().height > 0 && r.getBoundingClientRect().height < 30 && r.querySelector('svg.history__graph'))`));
  check('マージの印から下へ2列に分かれる', await js(`(() => { const r = document.querySelector('[data-hash="${merge}"]'); return Boolean(r.querySelector('.history__merge')) && new Set([...r.querySelectorAll('[data-edge="outgoing"]')].map((p) => p.dataset.to)).size === 2; })()`));
  check('現在のブランチの札にチェックと太字がある', await js(`(() => { const b = document.querySelector('[data-hash="${head}"] .history__ref[data-current="true"]'); return b?.textContent === 'current' && Boolean(b.querySelector('[data-icon="check"]')) && Number(getComputedStyle(b).fontWeight) >= 600; })()`));
  check('タグの札に値札の印がある', await js(`Boolean(document.querySelector('[data-hash="${merge}"] .history__ref[data-kind="tag"] [data-icon="tag"]'))`));
  check('mainとorigin/mainが1つの札にまとまる', await js(`(() => { const r = document.querySelector('[data-hash="${merge}"]'); const b = [...r.querySelectorAll('.history__ref')].find((b) => b.textContent === 'main'); return Boolean(b?.querySelector('[data-icon="cloud"]')) && b.title.includes('origin/main') && !r.textContent.includes('origin/main'); })()`));
  check('本文の印と件名の種類の太字がある', await js(`document.querySelector('[data-hash="${head}"] .history__body-mark')?.textContent === '↩' && document.querySelector('[data-hash="${head}"] .history__subject strong')?.textContent === 'feat:'`));
  const firstPage = await rows();
  const graphModule = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, 'renderer/historygraph.js')).toString('base64'));
  const firstLog = await require('./history').log(work);
  const firstGraph = graphModule.buildHistoryGraph(firstLog.rows.map((r) => r.commit));
  check('未プッシュの2件だけに矢印が付く', await js(`document.querySelectorAll('#history-list .history__unpushed').length === 2 && ['${parent}', '${head}'].every((h) => document.querySelector('[data-hash="' + h + '"] .history__unpushed'))`));
  await click('#history-more');
  await wait(`document.querySelectorAll('#history-list [data-hash]').length === ${total}`);
  check('さらに読み込むと残りが足され、末尾でボタンが消える', (await rows()).length === total && await js(`document.querySelector('#history-more').hidden`));
  const fullLog = await require('./history').log(work, { limit: total });
  const fullGraph = graphModule.buildHistoryGraph(fullLog.rows.map((r) => r.commit));
  const last = fullGraph.rows[99];
  const next = fullGraph.rows[100];
  const exits = [...last.through.map((p) => ({ column: p.column, color: p.color })), ...last.outgoing.map((p) => ({ column: p.to, color: p.color }))];
  const entries = [...next.through.map((p) => ({ column: p.column, color: p.color })), ...next.incoming.map((p) => ({ column: p.from, color: p.color }))];
  check('100件目と101件目の列と色が連続し、先の100件の配置も変わらない', firstPage[99] === last.hash && JSON.stringify(firstGraph.rows) === JSON.stringify(fullGraph.rows.slice(0, 100)) && exits.every((p) => entries.some((q) => p.column === q.column && p.color === q.color)));
  check('現在のブランチに未マージのコミットを混ぜない', !(await rows()).includes(unmerged));
  await js(`(() => { const s = document.querySelector('#history-scope'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await ready();
  await click('#history-more');
  await ready();
  check('すべてのブランチには未マージのコミットが出る', (await rows()).includes(unmerged));
  check('HEADから辿れない行だけ文字が薄い', await js(`(() => { const r = document.querySelector('[data-hash="${unmerged}"]'); const h = document.querySelector('[data-hash="${head}"]'); return r.dataset.reachable === 'false' && h.dataset.reachable === 'true' && getComputedStyle(r.querySelector('.history__subject')).color !== getComputedStyle(h.querySelector('.history__subject')).color && getComputedStyle(r.querySelector('.history__ref')).color === getComputedStyle(h.querySelector('.history__ref')).color; })()`));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'history-graph.png'), image.toPNG());
  await search('更新 11');
  check('件名の一部で絞れる', await js(`document.querySelectorAll('#history-list [data-hash]').length === 10 && [...document.querySelectorAll('#history-list .history__subject')].every((r) => r.textContent.includes('更新 11'))`));
  await search('TEST');
  check('作者でも大文字小文字を区別せず絞れる', (await rows()).length === 100);
  await search(head.slice(0, 12));
  check('ハッシュの先頭はそのコミットだけを返す', (await rows()).join() === head);
  const before = await js('window.__terp.activeKey');
  await click(`#history-list [data-hash="${head}"]`);
  await wait(`document.querySelector('.commit-view:not([hidden]) .commit-view__message')`);
  const key = `c:${work}@${head}`;
  check('表示中のタブの隣に詳細が開く', await js(`window.__terp.activeKey === ${JSON.stringify(key)} && window.__terp.tabOrder.indexOf(${JSON.stringify(key)}) === window.__terp.tabOrder.indexOf(${JSON.stringify(before)}) + 1`));
  check('メッセージの全文と変更ファイルが出る', await js(`document.querySelector('.commit-view:not([hidden]) .commit-view__message').textContent.includes(${JSON.stringify('詳細の本文\n\n2段落目')}) && Boolean(document.querySelector('.commit-view:not([hidden]) [data-file="a.txt"]'))`));
  const order = await js('window.__terp.tabOrder.length');
  await click(`#history-list [data-hash="${head}"]`);
  check('同じコミットのタブを増やさない', (await js('window.__terp.tabOrder.length')) === order);
  await click('.commit-view:not([hidden]) [data-file="a.txt"]');
  await wait(`document.querySelector('.commit-view:not([hidden]) .diff__row--add') && document.querySelector('.commit-view:not([hidden]) .diff__row--del')`);
  check('ファイルを押すと追加と削除の差分が出る', true);
  await click('.commit-view:not([hidden]) [data-file="a.txt"]');
  check('もう一度押すと差分が閉じる', await js(`document.querySelector('.commit-view:not([hidden]) .commit-view__diff').hidden`));
  await click(`.commit-view:not([hidden]) [data-parent="${parent}"]`);
  await wait(`window.__terp.activeKey === ${JSON.stringify(`c:${work}@${parent}`)}`);
  check('親のハッシュで親のコミットのタブが開く', true);
  const paneId = await js('window.__terp.activePaneId');
  await js(`window.__terp.dropTab(${JSON.stringify(key)}, ${JSON.stringify(paneId)}, 'right')`);
  check('詳細タブを別の枠へ動かせる', await js(`window.__terp.layout().type === 'split'`));
  await sleep(400);
  const saved = await js('window.terp.loadTabs()');
  check('詳細タブを開き直し用の控えに入れない', saved.ok && saved.value.order.every((k) => !k.startsWith('c:')) && !saved.value.active?.startsWith('c:') && !JSON.stringify(saved.value.layout).includes('c:'));
  await search('');
  await js(`window.__terp.openFile(${JSON.stringify(path.join(work, 'a.txt'))})`);
  await js(`[...document.querySelectorAll('.fileview:not([hidden]) .fileview__head button')].find((b) => b.textContent === '履歴').click()`);
  await ready();
  check('ファイルの履歴に絞っていることが見出しに出る', await js(`!document.querySelector('#history-path-filter').hidden && document.querySelector('#history-path').textContent.includes('a.txt')`));
  await click('#history-more');
  await ready();
  const expected = sh(['log', '--all', '--format=%H', '--', 'a.txt'], work).split('\n').sort();
  check('そのファイルを変更したコミットだけになる', (await rows()).sort().join() === expected.join());
  await click('#history-path-clear');
  await ready();
  check('×でファイルの絞り込みを解除できる', await js(`document.querySelector('#history-path-filter').hidden`));
  await js(`(() => { const s = document.querySelector('#history-scope'); s.value = 'current'; s.dispatchEvent(new Event('change')); })()`);
  await ready();
  await js(`[...document.querySelectorAll('.fileview:not([hidden]) .fileview__head button')].find((b) => b.textContent === '履歴').click()`);
  await ready();
  const otherWork = path.join(base, 'other-worktree');
  sh(['worktree', 'add', '-q', '-b', 'other-worktree', otherWork, root], work);
  await js(`window.__terp.open(${JSON.stringify(otherWork)})`);
  await ready();
  check('別の worktree へ移ると読み直し、ファイルの絞り込みを解除する', (await rows()).join() === root && await js(`document.querySelector('#history-path-filter').hidden && document.querySelector('#history-work').textContent === 'other-worktree'`));
  await js(`window.__terp.activate(${terminal})`);
  await ready();
  for (const name of ['files', 'git', 'history']) {
    await js(`window.__terp.setPanel('${name}')`);
    check(`${name} の面だけを表示する`, await js(`['files', 'git', 'history'].every((n) => document.getElementById(n + '-view').hidden === (n !== '${name}'))`));
  }
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  await js(`window.__terp.open(${JSON.stringify(outside)})`);
  await wait(`document.querySelector('#history-status').textContent === 'git のリポジトリではありません'`);
  check('git の外では案内を出す', true);
  await js(`window.__terp.activate(${terminal})`);
  await ready();
  check('別の場所から戻ると履歴を読み直す', (await rows()).length === 100);
  for (const api of ['historyCommit', 'historyDiff']) {
    for (const hash of ['HEAD', '--all', 'abc', 'a'.repeat(41), '1234;echo test']) {
      const result = await js(`window.terp.${api}(${JSON.stringify({ dir: work, hash, file: 'a.txt' })})`);
      check(`${api} は使えないハッシュを IPC で拒否する: ${hash}`, !result.ok && result.error.includes('16進'));
    }
  }
  // git の代わりに呼び出し回数を数え、検証より先に git を呼ばないことを確かめる
  const gitops = require('./git');
  const originalGit = gitops.git;
  const gitpanel = require('./gitpanel');
  const originalToplevel = gitpanel.toplevel;
  const modulePath = require.resolve('./history');
  const cached = require.cache[modulePath];
  let calls = 0;
  try {
    gitops.git = () => { calls++; throw new Error('git を呼び出した'); };
    gitpanel.toplevel = () => { calls++; throw new Error('git を呼び出した'); };
    delete require.cache[modulePath];
    const isolated = require('./history');
    for (const fn of [() => isolated.commit(work, 'HEAD'), () => isolated.commitDiff(work, '--all', 'a.txt')]) await fn().catch(() => {});
    check('ハッシュの検証に失敗したら git を呼ばない', calls === 0);
  } finally {
    gitops.git = originalGit;
    gitpanel.toplevel = originalToplevel;
    require.cache[modulePath] = cached;
  }
}

// TERP_SELFTEST_PERSIST=1→2→3 の順に、同じ TERP_CONFIG_DIR で3回起動して、セッションの保持を確かめる。
// 1: 印を付けて終わる / 2: 開き直してもシェルが生きている。常駐のプロセスを止める（Mac の再起動に当たる）/
// 3: 控えから同じ場所・名前で開き直す
async function runPersistTest({ js, check, outDir, phase }) {
  if (!process.env.TERP_CONFIG_DIR || path.resolve(process.env.TERP_CONFIG_DIR) === path.join(os.homedir(), '.config/terp')) throw new Error('保持の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const statePath = path.join(require('./config').CONFIG_DIR, 'selftest-tabs.json');
  const order = () => js('window.__terp.tabOrder');
  const fileKeys = () => js('window.__terp.tabOrder.filter((key) => key.startsWith("f:"))');
  const buffer = (id) => js(`window.__terp.bufferText(${id})`);
  const send = (id, data) => js(`window.terp.write(${id}, ${JSON.stringify(data)})`);
  const ids = () => js('[...window.__terp.sessions.keys()]');
  const waitFor = async (id, pattern) => {
    for (let t = 0; t < 40; t++) {
      if (pattern.test(await buffer(id))) return true;
      await sleep(250);
    }
    return false;
  };
  if (phase === '1') {
    const [id] = await ids();
    await send(id, 'export TERP_MARK=persist-ok; cd /tmp; echo phase1-output\r');
    check('1回目: 印を付ける', await waitFor(id, /\nphase1-output/));
    await js(`window.__terp.rename(${id}, '保持テスト')`);
    const workspace = await js("window.__terp.createWorkspace('保持用')");
    await js(`window.__terp.moveSessionWorkspace(${id}, ${JSON.stringify(workspace.id)})`);
    await js(`window.__terp.activate(${id})`);
    await js(`window.__terp.setSessionDraft(${id}, false)`);
    const dir = fs.mkdtempSync(path.join(path.resolve(outDir), 'persist-files-'));
    const files = [path.join(dir, 'first.js'), path.join(dir, 'second.md')];
    fs.writeFileSync(files[0], 'const first = 1;\n');
    fs.writeFileSync(files[1], '# second\n');
    for (const file of files) await js(`window.__terp.openFile(${JSON.stringify(file)})`);
    await js(`window.__terp.activateKey(${JSON.stringify(`f:${files[0]}`)})`);
    check('1回目: 2つのファイルをタブで開く', (await fileKeys()).length === 2);
    check('1回目: 1つ目のファイルを表示する', (await js('window.__terp.activeKey')) === `f:${files[0]}`);
    await js(`window.__terp.dropTab('t:${id}', window.__terp.layout().id, 'right')`);
    await dragSplitGutter(js, 70);
    await js(`window.__terp.activateKey(${JSON.stringify(`f:${files[0]}`)})`);
    const layout = await js('window.__terp.layout()');
    check('1回目: ファイルと端末を2枠で表示する', layout.type === 'split' && layout.children.length === 2);
    check('1回目: 枠の大きさを変える', layout.sizes[0] !== 0.5);
    fs.writeFileSync(statePath, JSON.stringify({ files, order: await order(), layout, workspace: workspace.id }));
    // 作業場所の控えが /tmp になるまで待つ（1.5 秒ごとに拾う）
    await sleep(3500);
    return;
  }
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (phase === '2') {
    const list = await ids();
    check('2回目: 開き直してもターミナルが残る', list.length === 1, `枚数 ${list.length}`);
    const id = list[0];
    const name = await js(`window.__terp.sessions.get(${id}).li.querySelector('.session__name').textContent`);
    check('2回目: ワークスペースとドラフトから外したことが残る', await js(`window.__terp.sessions.get(${id}).workspace === ${JSON.stringify(saved.workspace)} && window.__terp.sessions.get(${id}).draftOut && window.__terp.activeWorkspace === ${JSON.stringify(saved.workspace)}`));
    check('2回目: 名前が残る', name === '保持テスト', name);
    check('2回目: 前の出力が画面に戻る', /phase1-output/.test(await buffer(id)));
    const files = await fileKeys();
    check('2回目: 2つのファイルのタブが戻る', files.length === 2 && saved.files.every((file) => files.includes(`f:${file}`)));
    check('2回目: 枠の並びと大きさが戻る', JSON.stringify(await js('window.__terp.layout()')) === JSON.stringify(saved.layout));
    check('2回目: タブの並びが1回目と同じ', JSON.stringify(await order()) === JSON.stringify(saved.order));
    check('2回目: 1つ目のファイルを表示している', (await js('window.__terp.activeKey')) === `f:${saved.files[0]}`);
    await send(id, 'echo "mark=$TERP_MARK"\r');
    check('2回目: 同じシェルが動き続けている', await waitFor(id, /mark=persist-ok/));
    fs.rmSync(saved.files[1]);
    await sleep(2000);
    await js('window.terp.shutdownHost()');
    await sleep(500);
    return;
  }
  const list = await ids();
  check('3回目: 控えから開き直す', list.length === 1, `枚数 ${list.length}`);
  const id = list[0];
  const files = await fileKeys();
  check('3回目: 消したファイルのタブは開かない', !files.includes(`f:${saved.files[1]}`));
  check('3回目: 残ったファイルだけがタブで戻る', files.length === 1 && files[0] === `f:${saved.files[0]}`);
  await sleep(2000);
  const cwd = await js(`window.__terp.sessions.get(${id}).cwd`);
  check('3回目: 同じ作業場所で開く', /\/tmp$/.test(cwd), cwd);
  const name = await js(`window.__terp.sessions.get(${id}).li.querySelector('.session__name').textContent`);
  check('3回目: 控えからワークスペースとドラフトから外したことが戻る', await js(`window.__terp.sessions.get(${id}).workspace === ${JSON.stringify(saved.workspace)} && window.__terp.sessions.get(${id}).draftOut && window.__terp.activeWorkspace === ${JSON.stringify(saved.workspace)}`));
  check('3回目: 名前が戻る', name === '保持テスト', name);
  check('3回目: シェルは新しい（前の変数は無い）', !(await buffer(id)).includes('mark=persist-ok'));
}

// TERP_CONFIG_DIR の一時フォルダで実行し、利用者のリポジトリと設定には触れない。
async function runWorkspaceTest({ win, js, check, outDir }) {
  const { CONFIG_DIR, CONFIG_PATH } = require('./config');
  if (!process.env.TERP_CONFIG_DIR || path.resolve(CONFIG_DIR) === path.join(os.homedir(), '.config/terp')) throw new Error('ワークスペースの自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-workspace-')));
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  const wait = async (condition) => {
    for (let i = 0; i < 200; i++) { if (await condition()) return; await sleep(50); }
    throw new Error('ワークスペースの自己診断で応答を待ち切れなかった');
  };
  const visibleProjects = () => js('[...document.querySelectorAll("#projects .project")].map((el) => el.dataset.path)');
  const visibleSessions = () => js('[...document.querySelectorAll("#tree .session")].map((el) => Number(el.dataset.id))');
  const selectMenu = async (accelerator) => {
    const { Menu } = require('electron');
    const menu = Menu.getApplicationMenu().items.find((item) => item.label === 'ワークスペース');
    const item = menu?.submenu.items.find((entry) => entry.accelerator === accelerator);
    if (!item) throw new Error(`ワークスペースのメニューが無い: ${accelerator}`);
    item.click();
    await sleep(200);
  };
  try {
    const repos = ['work-repo', 'personal-repo'].map((name) => path.join(dir, name));
    for (const repo of repos) {
      fs.mkdirSync(repo);
      const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'test']);
      git(['config', 'user.email', 'test@example.com']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# workspace\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'init']);
    }
    fs.writeFileSync(path.join(CONFIG_DIR, 'projects.json'), JSON.stringify({ projects: repos.map((repo) => ({ path: repo })) }));
    const migrated = require('./projects').load();
    check('旧形式を読むと既定が1つできる', migrated.workspaces.length === 1 && migrated.workspaces[0].name === '既定');
    check('旧形式の全リポジトリが既定に属する', migrated.projects.every((p) => p.workspace === migrated.activeWorkspace));
    await js('window.__terp.refreshProjects()');
    const first = await js('window.__terp.activeWorkspace');
    const a = await js(`window.__terp.open(${JSON.stringify(repos[0])})`);
    await js(`window.terp.write(${a}, 'export TERP_WORKSPACE_MARK=alive; echo workspace-output\\r')`);
    await wait(() => js(`window.__terp.bufferText(${a}).includes('workspace-output')`));
    await js(`window.__terp.open(${JSON.stringify(repos[0])})`);
    await js(`window.__terp.dropTab('t:${a}', window.__terp.layout().id, 'right')`);
    const firstLayout = await js('window.__terp.layout()');
    const b = await js(`window.__terp.createWorkspace('個人')`);
    check('作ったワークスペースは一覧もタブも空', (await visibleProjects()).length === 0 && (await visibleSessions()).length === 0 && (await js('window.__terp.activeKey')) === null && !(await js('document.getElementById("empty").hidden')));
    const own = await js('window.__terp.open()');
    await js(`window.__terp.addProject(${JSON.stringify(repos[1])})`);
    await js(`window.__terp.moveProjectWorkspace(${JSON.stringify(repos[1])}, ${JSON.stringify(b.id)})`);
    check('表示中のワークスペースの端末とリポジトリだけが出る', JSON.stringify(await visibleProjects()) === JSON.stringify([repos[1]]) && JSON.stringify(await visibleSessions()) === JSON.stringify([own]));
    await js(`window.__terp.switchWorkspace(${JSON.stringify(first)})`);
    check('戻すと元の一覧と最後のタブになる', (await visibleProjects()).includes(repos[0]) && !(await visibleSessions()).includes(own) && (await js('window.__terp.activeId')) === a);
    check('切り替えて戻ると分割の配置も戻る', JSON.stringify(await js('window.__terp.layout()')) === JSON.stringify(firstLayout));
    await js(`window.terp.write(${a}, 'echo "workspace-mark=$TERP_WORKSPACE_MARK"\\r')`);
    await wait(() => js(`window.__terp.bufferText(${a}).includes('workspace-mark=alive')`));
    check('裏のシェルと出力が残る', await js(`window.__terp.bufferText(${a}).includes('workspace-output') && window.__terp.bufferText(${a}).includes('workspace-mark=alive')`));
    await selectMenu('Ctrl+Command+2');
    check('⌃⌘2 のメニューで2番目へ移る', (await js('window.__terp.activeWorkspace')) === b.id);
    await selectMenu('Ctrl+Command+]');
    check('⌃⌘] のメニューで次へ巡回する', (await js('window.__terp.activeWorkspace')) === first);
    await js(`window.__terp.moveProjectWorkspace(${JSON.stringify(repos[0])}, ${JSON.stringify(b.id)})`);
    check('リポジトリを動かすと元の一覧から消える', (await visibleProjects()).length === 0);
    check('端末の所属は変わらずその他に移る', await js(`window.__terp.sessions.get(${a}).li.closest('#loose') !== null`));
    await js(`window.__terp.switchWorkspace(${JSON.stringify(b.id)})`);
    check('移したリポジトリは移動先に出る', (await visibleProjects()).includes(repos[0]));
    await js(`window.__terp.moveSessionWorkspace(${a}, ${JSON.stringify(b.id)})`);
    check('移した端末は移動先の作業の下に出る', await js(`window.__terp.sessions.get(${a}).li.closest('.work')?.dataset.path === ${JSON.stringify(repos[0])}`));
    await js(`window.__terp.switchWorkspace(${JSON.stringify(first)})`);
    check('移した端末は元の一覧に出ない', !(await visibleSessions()).includes(a));
    check('中身のあるワークスペースは消せない', !(await js(`window.__terp.removeWorkspace(${JSON.stringify(b.id)})`)));
    const spare = await js("window.__terp.createWorkspace('空')");
    check('空のワークスペースを消せる', await js(`window.__terp.removeWorkspace(${JSON.stringify(spare.id)})`));

    await js('window.terp.updateConfig({ notifications: false })');
    await wait(() => js('window.__terp.config.notifications === false'));
    const fake = path.join(dir, 'claude');
    const node = execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
    fs.copyFileSync(node, fake);
    fs.chmodSync(fake, 0o755);
    const script = path.join(dir, 'waiting.js');
    fs.writeFileSync(script, "process.stdout.write('workspace-agent-ready\\n'); require('readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write('\\x1b]9;Claude needs your permission to use Bash\\x07'));\n");
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    await js(`window.__terp.switchWorkspace(${JSON.stringify(b.id)})`);
    await js(`window.terp.write(${a}, ${JSON.stringify(`${quote(fake)} ${quote(script)}\r`)})`);
    await wait(() => js(`window.__terp.sessions.get(${a}).program === 'claude' && window.__terp.bufferText(${a}).includes('workspace-agent-ready')`));
    await js(`window.__terp.switchWorkspace(${JSON.stringify(first)})`);
    await js(`window.__terp.sessions.get(${a}).term.input('permission\\r', true)`);
    await wait(() => js(`window.__terp.stateOf(window.__terp.sessions.get(${a})) === 'waiting'`));
    await js('window.__terp.renderAll()');
    check('裏の許可待ちを切り替え部品に出す', await js("document.querySelector('#workspace-switch .work__status').dataset.agentState === 'waiting'"));
    await js("document.getElementById('workspace-switch').click()");
    check('一覧のワークスペース名にも許可待ちを出す', await js(`document.querySelector('[data-workspace-status=${JSON.stringify(b.id)}]').dataset.agentState === 'waiting'`));
    await js('window.__terp.nextAttention()');
    check('次の要対応は裏のワークスペースへ移る', (await js('window.__terp.activeWorkspace')) === b.id && (await js('window.__terp.activeId')) === a);
    // 星と × は同じ行の隣り合う別の場所に置き、押し間違えないようにする
    const buttons = await js(`(() => {
      const row = window.__terp.sessions.get(${a}).li;
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { star: box(row.querySelector('.session__draft')), close: box(row.querySelector('.session__close')) };
    })()`);
    check('ドラフトの星と閉じるの × が重ならない',
      buttons.star.right <= buttons.close.left && buttons.star.bottom > buttons.close.top && buttons.star.top < buttons.close.bottom,
      JSON.stringify(buttons));
    await js("window.terp.updateConfig({ accent: '#eeeeee', backgroundOpacity: 0.65 })");
    await wait(() => js("window.__terp.config.chrome.accent === '#eeeeee' && window.__terp.config.window.opacity === 0.65"));
    await js(`window.__terp.setSidebarView('all', { animate: false })`);
    const head = `document.querySelector('.project[data-path=${JSON.stringify(repos[0])}] .project__head')`;
    await wait(() => js(`Boolean(${head})`));
    const colors = await js(`(() => {
      const head = ${head};
      const style = getComputedStyle(head), sidebar = getComputedStyle(document.getElementById('sidebar'));
      return { text: style.color, star: getComputedStyle(head.querySelector('.draft-star')).color, image: style.backgroundImage, sidebar: sidebar.backgroundColor,
        primary: getComputedStyle(document.getElementById('new-terminal')).backgroundImage };
    })()`);
    const rgba = (value) => value.match(/[\d.]+/g).map(Number);
    const { contrast, luminance } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, 'renderer/favcolor.js')).toString('base64'));
    const hex = (value) => '#' + rgba(value).slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('');
    check('「すべて」でドラフト済みのリポジトリの背景が強調色のぼかしになる', colors.image.startsWith('linear-gradient'), colors.image);
    fs.writeFileSync(path.join(outDir, 'draft-gradient.png'), (await win.webContents.capturePage()).toPNG());
    check('ドラフトの背景の不透明度が一覧と同じ', /\/ 0\.65\)/.test(colors.image) && rgba(colors.sidebar)[3] === 0.65, colors.image);
    check('文字は暗くなりコントラスト比4.5以上', contrast('#eeeeee', hex(colors.text)) >= 4.5 && luminance(hex(colors.text)) < luminance('#eeeeee'));
    check('星も同じ色', colors.star === colors.text);
    await js(`window.__terp.setSidebarView('draft', { animate: false })`);
    await wait(() => js(`window.__terp.sessions.get(${a}).li.isConnected`));
    check('新しいターミナルのボタンは強調色のぼかしになる', (await js(`getComputedStyle(document.getElementById('new-terminal')).backgroundImage`)).startsWith('linear-gradient'));
    await sleep(500);
    const stored = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'projects.json'), 'utf8'));
    const tabs = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'tabs.json'), 'utf8'));
    check('所属とドラフトが projects.json に残る', stored.workspaces.length === 2 && stored.activeWorkspace === b.id && stored.projects.find((p) => p.path === repos[0]).draft === true);
    check('ワークスペースごとのタブと配置が tabs.json に残る', tabs.workspaces[first] && tabs.workspaces[b.id]?.active === `t:${a}` && tabs.workspaces[b.id]?.layout);
    await js(`window.__terp.setSidebarView('all', { animate: false })`);
    await wait(() => js(`Boolean(${head})`));
    await js(`${head}.click()`);
    check('ドラフトから外すと背景が戻る', await (async () => { for (let i = 0; i < 40; i++) { if (await js(`${head}?.dataset.draft === 'false' && getComputedStyle(${head}).backgroundImage === 'none'`)) return true; await sleep(100); } return false; })());
    await js(`${head}.click()`);
    await js(`window.__terp.setSidebarView('draft', { animate: false })`);
    fs.writeFileSync(path.join(outDir, 'workspace-colors.json'), JSON.stringify(colors, null, 2));
  } finally {
    fs.writeFileSync(CONFIG_PATH, original);
    await js('Promise.all([...window.__terp.sessions.keys()].map((id) => window.terp.kill(id)))');
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_OVERVIEW は、一時フォルダの端末で一覧・検索・所属をまたぐ移動を確かめる。
async function runOverviewTest({ win, js, check, outDir }) {
  const { CONFIG_DIR } = require('./config');
  if (!process.env.TERP_CONFIG_DIR || path.resolve(CONFIG_DIR) === path.join(os.homedir(), '.config/terp')) throw new Error('全体の一覧の自己診断には一時フォルダの TERP_CONFIG_DIR が必要');
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-overview-')));
  const wait = async (condition) => {
    for (let i = 0; i < 200; i++) { if (await condition()) return; await sleep(50); }
    throw new Error('全体の一覧の自己診断で応答を待ち切れなかった');
  };
  const menu = require('electron').Menu.getApplicationMenu().items.find((item) => item.label === '移動');
  const item = menu?.submenu.items.find((entry) => entry.label === '全体の一覧');
  if (!item) throw new Error('全体の一覧のメニューが無い');
  const opened = () => js('document.getElementById("overview").open');
  const selected = () => js('Number(document.querySelector(".overview__tile[aria-selected=true]")?.dataset.id)');
  const tileIds = () => js('[...document.querySelectorAll(".overview__tile")].map((tile) => Number(tile.dataset.id))');
  const press = async (key) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await sleep(50);
  };
  const query = async (value) => {
    await js('document.getElementById("overview-query").focus(); document.getElementById("overview-query").select()');
    if (value) await win.webContents.insertText(value);
    else await press('Backspace');
  };
  const openMenu = async () => { item.click(); await wait(opened); };
  const escape = async () => { await press('Escape'); await wait(async () => !(await opened())); };
  try {
    const repo = path.join(dir, 'overview-repo');
    const loose = path.join(dir, 'loose-location');
    fs.mkdirSync(repo);
    fs.mkdirSync(loose);
    execFileSync('git', ['init', '-q', '-b', 'overview-branch'], { cwd: repo });
    const first = await js('window.__terp.activeWorkspace');
    await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
    const a = await js(`window.__terp.open(${JSON.stringify(repo)})`);
    const b = await js(`window.__terp.open(${JSON.stringify(loose)})`);
    const second = await js('window.__terp.createWorkspace("一覧の別の作業")');
    const c = await js(`window.__terp.open(${JSON.stringify(loose)})`);
    for (const [id, mark] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
      await js(`window.__terp.rename(${id}, ${JSON.stringify(`一覧の確認 ${mark}`)})`);
      await js(`window.terp.write(${id}, ${JSON.stringify(`printf 'OVERVIEW-%s\\n' '${mark}'\r`)})`);
      await wait(() => js(`window.__terp.bufferText(${id}).includes(${JSON.stringify(`OVERVIEW-${mark}`)})`));
    }
    const fake = path.join(dir, 'claude');
    const node = execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
    fs.copyFileSync(node, fake);
    fs.chmodSync(fake, 0o755);
    const script = path.join(dir, 'waiting.js');
    fs.writeFileSync(script, "process.stdout.write('\\x1b]0;\u2733 一覧の要件の確認\\x07overview-agent-ready\\nOVERVIEW-C\\n'); require('readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write('\\x1b]9;Claude needs your permission to use Bash\\x07'));\n");
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    await js(`window.terp.write(${c}, ${JSON.stringify(`${quote(fake)} ${quote(script)}\r`)})`);
    await wait(() => js(`window.__terp.sessions.get(${c}).program === 'claude' && window.__terp.bufferText(${c}).includes('overview-agent-ready')`));
    await js(`window.__terp.switchWorkspace(${JSON.stringify(first)}); window.__terp.activate(${a})`);
    check('メニューに ⌘M が割り当てられている', item.accelerator === 'CmdOrCtrl+M');
    check('一覧のボタンに ⌘M が見える', await js('document.getElementById("overview-open").textContent.includes("⌘M")'));
    await openMenu();
    check('端末に焦点があるときもメニューで開ける', await opened());
    check('開くと検索欄に焦点がある', await js('document.activeElement.id === "overview-query"'));
    check('全所属の端末が重複せずに出る', await js('JSON.stringify([...document.querySelectorAll(".overview__tile")].map((tile) => Number(tile.dataset.id)).sort((a, b) => a - b)) === JSON.stringify([...window.__terp.sessions.keys()].sort((a, b) => a - b))'));
    check('表示中のターミナルが選ばれ、枠が付く', (await selected()) === a && await js(`document.querySelector('.overview__tile[data-id="${a}"]').getAttribute('aria-current') === 'true'`));
    check('表示中の所属を先頭にして所属ごとにまとめる', await js(`(() => {
      const groups = [...document.querySelectorAll('.overview__workspace')];
      return groups[0].dataset.workspace === ${JSON.stringify(first)} && groups.some((el) => el.dataset.workspace === ${JSON.stringify(second.id)})
        && [...document.querySelectorAll('.overview__tile')].every((el) => el.closest('.overview__workspace').dataset.workspace === window.__terp.sessions.get(Number(el.dataset.id)).workspace);
    })()`));
    check('開いているタブの端末を所属の先頭のまとまりに出す', await js(`(() => {
      const group = document.querySelector('.overview__tile[data-id="${a}"]').closest('.overview__repo');
      return group.dataset.group === 'open' && group === document.querySelector('.overview__workspace .overview__repo');
    })()`));
    const tabLabels = await js(`[...document.querySelectorAll('.overview__tab')].map((el) => el.querySelector('.overview__tab-label').textContent + ':' + el.querySelector('.overview__tab-count').textContent)`);
    check('上端にすべて・開いているタブ・リポジトリ・その他のタブが並ぶ',
      JSON.stringify(tabLabels) === JSON.stringify(['すべて:4', '開いているタブ:1', 'overview-repo:1', 'その他のターミナル:3']), JSON.stringify(tabLabels));
    await js(`document.querySelector('.overview__tab[data-tab="repo:' + ${JSON.stringify(repo)} + '"]').click()`);
    await sleep(200);
    check('リポジトリのタブを押すと、そのリポジトリの端末だけを出す', JSON.stringify(await tileIds()) === JSON.stringify([a]));
    await js(`document.getElementById('overview-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await sleep(200);
    check('⌃Tab で次のタブへ移る', (await js(`document.querySelector('.overview__tab[aria-selected="true"]').dataset.tab`)) === 'loose' && !(await tileIds()).includes(a));
    await js(`document.querySelector('.overview__tab[data-tab="all"]').click()`);
    await sleep(200);
    check('表示していない端末はその他のターミナルに出す', await js(`document.querySelector('.overview__tile[data-id="${b}"]').closest('.overview__repo').dataset.group === 'loose'`));
    const labelsC = await js(`({ main: document.querySelector('.overview__tile[data-id="${c}"] .overview__name').textContent,
      meta: document.querySelector('.overview__tile[data-id="${c}"] .overview__meta').textContent })`);
    check('エージェントの端末は、端末の題名（要件）を見出しにし、名前とプログラムを下に出す',
      labelsC.main === '一覧の要件の確認' && labelsC.meta.includes('一覧の確認 C') && labelsC.meta.endsWith('claude'), JSON.stringify(labelsC));
    check('リポジトリの端末は下の行にブランチを出す', (await js(`document.querySelector('.overview__tile[data-id="${a}"] .overview__meta').textContent`)).includes('overview-branch'));
    check('全所属の縮小画面に出力の末尾が出る', await js(`[[${a}, 'A'], [${b}, 'B'], [${c}, 'C']].every(([id, mark]) => document.querySelector('.overview__tile[data-id="' + id + '"] .overview__preview').textContent.includes('OVERVIEW-' + mark))`));
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'overview.png'), img.toPNG()));
    await escape();
    check('Esc で閉じる', !(await opened()));
    await js('document.getElementById("overview-open").click()');
    await wait(opened);
    check('ボタンで開く', await opened());
    await escape();
    check('ボタンで開いた一覧も Esc で閉じる', !(await opened()));
    await openMenu();
    item.click();
    await wait(async () => !(await opened()));
    check('もう一度 ⌘M のメニューで閉じる', !(await opened()));

    await openMenu();
    await query('一覧の確認');
    check('名前で絞り込む', JSON.stringify((await tileIds()).sort((x, y) => x - y)) === JSON.stringify([a, b, c].sort((x, y) => x - y)));
    const initial = await selected();
    await press('Down');
    check('検索欄から矢印キーで選びを動かす', (await selected()) !== initial);
    for (let i = 0; i < 5 && (await selected()) !== c; i++) await press('Down');
    check('見た目の下方向へ進むと別の所属の端末を選べる', (await selected()) === c);
    await press('Return');
    await wait(async () => !(await opened()) && await js(`window.__terp.activeId === ${c}`));
    check('Enter で閉じて別のワークスペースへ移る', (await js('window.__terp.activeWorkspace')) === second.id);
    await openMenu();
    check('表示から外れた端末はリポジトリのまとまりに戻る', await js(`document.querySelector('.overview__tile[data-id="${a}"]').closest('.overview__repo').dataset.repo === ${JSON.stringify(repo)}`));
    check('切り替えた所属が先頭になり、移った端末を選ぶ', (await selected()) === c && await js(`document.querySelector('.overview__workspace').dataset.workspace === ${JSON.stringify(second.id)}`));
    await query('確認 c');
    check('英字の大小を区別せず絞り込む', JSON.stringify(await tileIds()) === JSON.stringify([c]));
    await query('要件の確認');
    check('要件で絞り込む', JSON.stringify(await tileIds()) === JSON.stringify([c]));
    await query('OVERVIEW-REPO');
    check('リポジトリ名で絞り込む', JSON.stringify(await tileIds()) === JSON.stringify([a]));
    await query('overview-branch');
    check('ブランチ名で絞り込む', JSON.stringify(await tileIds()) === JSON.stringify([a]));
    await query('loose-location');
    check('作業場所で絞り込む', JSON.stringify((await tileIds()).sort((x, y) => x - y)) === JSON.stringify([b, c].sort((x, y) => x - y)));
    await query('一致しない端末名');
    check('一致しないと空の文を出す', (await tileIds()).length === 0 && await js('!document.querySelector(".overview__empty").hidden && document.querySelector(".overview__empty").textContent === "合うターミナルはない"'));
    await press('Return');
    check('一致しないと Enter で移動しない', await opened());
    await query('');
    await js(`document.querySelector('.overview__tile[data-id="${a}"]').click()`);
    await wait(async () => !(await opened()));
    check('クリックでも所属をまたいで移る', await js(`window.__terp.activeId === ${a} && window.__terp.activeWorkspace === ${JSON.stringify(first)}`));

    await openMenu();
    await js(`window.__terp.sessions.get(${c}).term.input('permission\\r', true)`);
    await wait(() => js(`document.querySelector('.overview__tile[data-id="${c}"]').dataset.agentState === 'waiting'`));
    check('裏の許可待ちが定期更新で印に反映される', await js(`document.querySelector('.overview__tile[data-id="${c}"] .session__dot').textContent === '!' && document.querySelector('.overview__tile[data-id="${c}"] .session__dot').getAttribute('aria-label') === '許可待ち'`));
    check('定期更新で選びと入力の焦点を失わない', (await selected()) === a && await js('document.activeElement.id === "overview-query"'));
    await escape();
    await js('Promise.all([...window.__terp.sessions.keys()].map((id) => window.terp.kill(id)))');
    await wait(() => js('window.__terp.sessions.size === 0'));
    await openMenu();
    check('端末が無いときの文を出す', await js('!document.querySelector(".overview__empty").hidden && document.querySelector(".overview__empty").textContent === "ターミナルはない"'));
    await js('document.querySelector(".overview__list").click()');
    check('背景を押すと閉じる', !(await opened()));
  } finally {
    await js('document.getElementById("overview").dispatchEvent(new Event("cancel", { cancelable: true }))');
    await js('Promise.all([...window.__terp.sessions.keys()].map((id) => window.terp.kill(id)))');
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TERP_SELFTEST_WORK を付けると、一時フォルダに git のリポジトリを作り、作業（worktree）の
// 追加・作成・振り分け・削除を確かめる。TERP_CONFIG_DIR に一時フォルダを指定すること
async function runWorkTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const repo = path.join(fs.realpathSync(outDir), 'sample-repo');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(`${repo}.worktrees`, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.name', 'test'], repo);
  sh(['config', 'user.email', 'test@example.com'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# sample\n');
  sh(['add', '.'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);

  const tree = () => js(`document.getElementById('tree').innerText`);
  const firstId = await js('window.__terp.activeId');
  fs.writeFileSync(path.join(outDir, '0-start.txt'), await js(`window.__terp.bufferText(${firstId})`));
  const res = await js(`window.__terp.addProject(${JSON.stringify(repo)})`);
  check('リポジトリを追加できる', res.ok, res.error || '');
  const t1 = await tree();
  check('本体の作業が一覧に出る', t1.includes('sample-repo') && t1.includes('main') && t1.includes('本体'), t1.replace(/\n/g, ' | '));

  // 画面の入力欄に値を入れて「作成」を押す
  await js(`(() => {
    window.__terp.openWorkDialog(${JSON.stringify(repo)});
    const f = document.querySelector('#work-dialog form');
    f.elements.branch.value = 'feature/try-terp';
    f.elements.command.value = '';
  })()`);
  await sleep(300);
  fs.writeFileSync(path.join(outDir, '0-after-dialog.txt'), await js(`window.__terp.bufferText(${firstId})`));
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, '1-dialog.png'), img.toPNG()));
  await js(`document.querySelector('#work-dialog form').requestSubmit()`);
  await sleep(2500);
  const dest = `${repo}.worktrees/feature-try-terp`;
  check('作成で worktree ができる', fs.existsSync(path.join(dest, 'README.md')), dest);
  const activeWork = await js('window.__terp.workOf(window.__terp.activeId)');
  check('作った作業でターミナルが開く', activeWork === dest, activeWork);
  const t2 = await tree();
  check('作業が一覧に出る', t2.includes('feature/try-terp'), t2.replace(/\n/g, ' | '));

  // 外で作った worktree も拾う
  sh(['worktree', 'add', '-q', '-b', 'outside', `${repo}-outside`], repo);
  await js('window.__terp.refreshProjects()');
  await sleep(500);
  check('外で作った worktree も一覧に出る', (await tree()).includes('outside'));

  // 変更が残っていると削除できない
  fs.writeFileSync(path.join(dest, 'note.txt'), 'wip\n');
  await js('window.__terp.refreshProjects()');
  await sleep(500);
  const badge = await js(`document.querySelector('.work[data-path="${dest}"] .badge')?.textContent || ''`);
  check('変更の数が出る', badge === '1', badge);
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, '2-tree.png'), img.toPNG()));
  const work = `window.__terp.projects[0].worktrees.find((w) => w.path === ${JSON.stringify(dest)})`;
  await js(`window.__terp.openRemoveDialog({ ...${work}, repo: ${JSON.stringify(repo)} })`);
  await sleep(500);
  const blocked = await js(`document.querySelector('#remove-dialog [data-action="submit"]').disabled`);
  check('変更が残る作業は削除できない', blocked === true);
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, '3-remove-blocked.png'), img.toPNG()));
  await js(`document.getElementById('remove-dialog').close()`);

  // 片付けたら削除でき、ブランチは残る
  fs.rmSync(path.join(dest, 'note.txt'));
  await js(`window.__terp.openRemoveDialog({ ...${work}, repo: ${JSON.stringify(repo)} })`);
  await sleep(500);
  await js(`document.querySelector('#remove-dialog form').requestSubmit()`);
  await sleep(2000);
  check('削除で worktree が消える', !fs.existsSync(dest));
  check('削除してもブランチは残る', sh(['branch', '--list', 'feature/try-terp'], repo).includes('feature/try-terp'));
  const sessionsLeft = await js(`[...window.__terp.sessions.values()].filter((s) => s.cwd?.startsWith(${JSON.stringify(dest)})).length`);
  check('作業のターミナルは閉じる', sessionsLeft === 0, `残り ${sessionsLeft}`);

  // リポジトリの並べ替え: 2つ目を足し、ドラッグ＆ドロップで先頭へ、⌥↓ で戻す
  const repo2 = path.join(outDir, 'second-repo');
  fs.mkdirSync(repo2, { recursive: true });
  sh(['init', '-q', '-b', 'main'], repo2);
  await js(`window.__terp.addProject(${JSON.stringify(repo2)})`);
  await sleep(500);
  const order = () => js(`[...document.querySelectorAll('#projects .project')].map((p) => p.dataset.path.split('/').pop())`);
  const saved = () => JSON.parse(fs.readFileSync(path.join(require('./config').CONFIG_DIR, 'projects.json'), 'utf8')).projects.map((p) => p.path.split('/').pop());
  check('足したリポジトリは後ろに並ぶ', (await order()).join() === 'sample-repo,second-repo', (await order()).join());
  await js(`(() => {
    const dt = new DataTransfer();
    const from = document.querySelector('.project[data-path=${JSON.stringify(repo2)}] .project__head');
    const to = document.querySelector('.project[data-path=${JSON.stringify(repo)}]');
    const r = to.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 2 };
    from.dispatchEvent(new DragEvent('dragstart', at));
    to.dispatchEvent(new DragEvent('dragover', at));
    to.dispatchEvent(new DragEvent('drop', at));
    from.dispatchEvent(new DragEvent('dragend', at));
  })()`);
  await sleep(800);
  check('ドラッグ＆ドロップで並びが変わる', (await order()).join() === 'second-repo,sample-repo', (await order()).join());
  check('並びが projects.json に残る', saved().join() === 'second-repo,sample-repo', saved().join());
  await js(`(() => {
    const head = document.querySelector('.project[data-path=${JSON.stringify(repo2)}] .project__head');
    head.focus();
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
  })()`);
  await sleep(800);
  check('⌥↓ でも並びを変えられる', (await order()).join() === 'sample-repo,second-repo' && saved().join() === 'sample-repo,second-repo', (await order()).join());
  await js('window.__terp.refreshProjects()');
  await sleep(500);
  check('読み直しても並びが保たれる', (await order()).join() === 'sample-repo,second-repo');
}

// TERP_SELFTEST_THEME を付けると、設定ファイルを書き換えてテーマと透過の反映を確かめる。
// TERP_CONFIG_DIR に一時フォルダを指定し、利用者の設定を書き換えないこと
async function runThemeTest({ win, js, send, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const { execFileSync } = require('child_process');
  const writeConfig = async (body) => {
    fs.writeFileSync(CONFIG_PATH, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    await sleep(1200);
  };
  // 画面収録の許可が無いと screencapture は使えないため、ページの画面を撮る。
  // 透過した部分は PNG の透明度として残る（後ろのデスクトップは写らない）
  const shoot = async (name) => {
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  const id = await js('window.__terp.activeId');
  await send(id, "printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan\\e[0m\\n'\r");
  await js('window.__terp.open()');
  await sleep(1500);
  await shoot('1-default');
  check('不透明の窓は影を付ける', win.hasShadow());

  await writeConfig({ theme: 'Sakura Night' });
  const accent = await js('window.__terp.config.chrome.accent');
  check('テーマ名だけで Ghostty のテーマが読める', accent === '#ff9ebb', `強調色 ${accent}`);
  const termFg = await js(`window.__terp.sessions.get(${id}).term.options.theme.foreground`);
  check('開いている端末にも反映される', termFg === '#f5d5de', `文字色 ${termFg}`);
  // 面は強調色をわずかにずらしたぼかし、縁は強調色そのもの
  const btn = await js(`(() => { const style = getComputedStyle(document.getElementById('new-terminal')); return { image: style.backgroundImage, border: style.borderTopColor }; })()`);
  check('新規ボタンが強調色になる', btn.border === 'rgb(255, 158, 187)' && btn.image.startsWith('linear-gradient'), JSON.stringify(btn));
  await shoot('2-sakura');

  await writeConfig({ theme: 'Sakura Night', backgroundOpacity: 0.75, backgroundBlur: true });
  const surface = await js(`getComputedStyle(document.getElementById('terminals')).backgroundColor`);
  check('不透明度が背景に反映される', surface.includes('0.75'), surface);
  // 端末の中央に重なる要素のうち、不透明な背景を持つものが無いこと
  const opaque = await js(`(() => {
    const r = document.querySelector('.term:not([hidden])').getBoundingClientRect();
    return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .map((el) => [el.className || el.tagName, getComputedStyle(el).backgroundColor])
      .filter(([, bg]) => bg.startsWith('rgb(') || bg.startsWith('#'))
      .map(([name, bg]) => name + ' ' + bg).join(' / ');
  })()`);
  check('端末の面に不透明な背景が残らない', opaque === '', opaque);
  // 透明な窓の影は四角い窓の形のまま描かれ、丸い角の外に線が残るため切る
  check('透かすと窓の影を切る', !win.hasShadow());
  const { setBlur } = require('./blur');
  check('窓の後ろのぼかしの関数が通る', setBlur(win, 20) === true);
  check('ぼかしを外せる', setBlur(win, 0) === true);
  await shoot('3-sakura-transparent');

  await writeConfig({ theme: 'Sakura Night', accent: '#ff69b4' });
  check('不透明に戻すと影も戻る', win.hasShadow());
  const custom = await js('window.__terp.config.chrome.accent');
  check('強調色だけ上書きできる', custom === '#ff69b4', custom);

  await writeConfig('{ "theme": ');
  const brokenMsg = await js(`document.getElementById('config-error').hidden ? '' : document.getElementById('config-error').textContent`);
  check('JSON の誤りを画面に出す', brokenMsg.includes('config.json'), brokenMsg);

  await writeConfig({ theme: 'No Such Theme' });
  const missingMsg = await js(`document.getElementById('config-error').textContent`);
  check('無いテーマ名を画面に出す', missingMsg.includes('No Such Theme'), missingMsg);

  await writeConfig({ theme: 'Sakura Night' });
  const cleared = await js(`document.getElementById('config-error').hidden`);
  check('直したら誤りの表示が消える', cleared === true);
}

exports.run = (win) => {
  const outDir = process.env.TERP_SELFTEST;
  const log = [];
  const check = (label, ok, detail = '') => log.push(`${ok ? 'OK ' : 'NG '} ${label}${detail ? ` (${detail})` : ''}`);

  win.webContents.on('console-message', (event) => log.push(`console: ${event.message} @${event.sourceId}:${event.lineNumber}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) =>
      win.webContents.executeJavaScript(code).catch((err) => {
        log.push(`ERR ${code}: ${err.message}`);
        fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
        throw err;
      });
    const send = (id, data) => js(`window.terp.write(${id}, ${JSON.stringify(data)})`);
    const buffer = (id) => js(`window.__terp.bufferText(${id})`);
    // 起動直後はシェルの立ち上がりが遅いことがあるため、決まった秒数ではなく出力を待つ
    const waitFor = async (id, pattern, ms = 10000) => {
      for (let t = 0; t < ms; t += 250) {
        if (pattern.test(await buffer(id))) return true;
        await sleep(250);
      }
      return false;
    };
    const sidebar = () => js(`document.getElementById('tree').innerText`);
    fs.mkdirSync(outDir, { recursive: true });
    // 自己診断の常駐のプロセスは設定のフォルダごとに別に立つため、終わるときに止める
    const finish = async () => {
      await js('window.terp.shutdownHost()').catch(() => {});
      app.quit();
    };

    await sleep(2500);
    // TERP_SELFTEST_DIAG を付けると、何も操作せずに起動の様子だけを書き出して終わる。
    // 利用者の設定のまま使うため、常駐のプロセスもシェルも止めない
    if (process.env.TERP_SELFTEST_DIAG) {
      // TERP_SELFTEST_QUITBUSY を付けると、出力が流れ続けるシェルを置いたまま終わる（閉じても居残らないかを見る）
      if (process.env.TERP_SELFTEST_QUITBUSY) {
        const id = await js('window.__terp.activeId');
        await js(`window.terp.write(${id}, ${JSON.stringify('while true; do echo busy; sleep 0.05; done\r')})`);
      }
      await sleep(4000);
      const sessions = await js('[...window.__terp.sessions.values()].map((s) => s.id + " " + s.cwd)').catch((e) => [`ERR ${e.message}`]);
      log.push(`sessions: ${JSON.stringify(sessions)}`);
      fs.writeFileSync(path.join(outDir, 'screen.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      app.quit();
      return;
    }
    const tui = process.env.TERP_SELFTEST_CMD;
    if (tui) {
      // TERP_SELFTEST_CMD を指定したときは、その TUI を起動した画面を撮る
      const id = await js('window.__terp.activeId');
      const titles = [];
      const title = () => js(`window.__terp.sessions.get(${id}).title`);
      await send(id, tui + '\r');
      await sleep(9000);
      titles.push(`起動後: ${await title()}`);
      // TERP_SELFTEST_PROMPT を指定したら、送って応答の後のタイトルも控える
      const prompt = process.env.TERP_SELFTEST_PROMPT;
      if (prompt) {
        await send(id, prompt);
        await sleep(500);
        await send(id, '\r');
        for (let t = 0; t < 40; t++) {
          await sleep(1000);
          const now = await title();
          if (titles[titles.length - 1] !== `応答中: ${now}`) titles.push(`応答中: ${now}`);
        }
      }
      fs.writeFileSync(path.join(outDir, 'titles.txt'), titles.join('\n') + '\n');
      fs.writeFileSync(path.join(outDir, 'screen.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(outDir, 'sidebar.txt'), await sidebar());
      await send(id, '\x03');
      await sleep(300);
      await send(id, '\x03');
      await sleep(1500);
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_PERSIST) {
      await runPersistTest({ js, check, outDir, phase: process.env.TERP_SELFTEST_PERSIST });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      // 1 と 2 は常駐のプロセスを残したまま終わる（開き直しを確かめるため）
      if (process.env.TERP_SELFTEST_PERSIST === '3') await finish();
      else app.quit();
      return;
    }

    if (process.env.TERP_SELFTEST_SIDEBAR) {
      await runSidebarTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_SHORTCUTS) {
      await runShortcutsTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_LOCK) {
      await runLockTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_DRAFT) {
      await runDraftTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_DROPREPO) {
      await runDropRepoTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_COMMANDS) {
      await runCommandsTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_AGENTHISTORY) {
      await runAgentHistoryTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_MDPREVIEW) {
      await runMarkdownPreviewTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_NEWREPO) {
      await runNewRepoTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }
    if (process.env.TERP_SELFTEST_KEYS) {
      await runKeysTest({ win, js, check });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_WALLPAPER) {
      await runWallpaperTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_HISTORY) {
      await runHistoryTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_GIT) {
      await runGitTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_THEMEAI) {
      await runThemeAiTest({ win, js, check, outDir });
      check('CSP の違反が無い', !log.some((line) => line.startsWith('console:') && line.includes('violates')));
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_AGENTREG) {
      await runAgentRegistryTest({ win, js, check, outDir });
      check('CSP の違反が無い', !log.some((line) => line.startsWith('console:') && line.includes('violates')));
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_AGENTSTATUS) {
      await runAgentStatusTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_NOTIFY) {
      await runNotifyTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_GHOSTTY) {
      await runGhosttyTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_SETTINGS) {
      await runSettingsTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_EDITOR) {
      await runEditorTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_SUBAGENTS) {
      await runSubagentsTest({ win, js, check, outDir });
      check('CSP の違反が無い', !log.some((line) => line.startsWith('console:') && line.includes('violates')));
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_PATHLINKS === '1') {
      await runPathLinksTest({ js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_DROPPATHS === '1') {
      await runDropPathsTest({ js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_PANETITLE) {
      await runPaneTitleTest({ js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_SPLIT) {
      await runSplitTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_FILES) {
      await runFilesTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_AGENTS) {
      await runAgentsTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, 'agents.png'), img.toPNG()));
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_OVERVIEW) {
      await runOverviewTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_WORKSPACE) {
      await runWorkspaceTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_WORK) {
      await runWorkTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    if (process.env.TERP_SELFTEST_THEME) {
      await runThemeTest({ win, js, send, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      await finish();
      return;
    }

    // Electron 45 からクリップボードの読み書きは Promise を返す
    const savedClipboard = await clipboard.readText();
    const id1 = await js('window.__terp.activeId');
    await send(id1, 'claude --version\r');
    check('1枚目で claude が動く', await waitFor(id1, /\(Claude Code\)/));

    const id2 = await js(`window.__terp.open(${JSON.stringify(path.join(os.homedir(), 'claude-tools/terp'))})`);
    await send(id2, 'codex --version\r');
    check('2枚目で codex が動く', await waitFor(id2, /codex-cli/));

    // ⌘T 相当: 表示中（2枚目）と同じ作業場所で開く
    win.webContents.send('menu', 'new');
    await sleep(1500);
    const id3 = await js('window.__terp.activeId');
    await send(id3, 'pwd; cd /tmp\r');
    await sleep(2500);
    check('新規は表示中と同じ作業場所', (await buffer(id3)).includes('claude-tools/terp'));
    check('cd が一覧に反映される', (await sidebar()).includes('/tmp'), (await sidebar()).replace(/\n/g, ' | '));

    // 裏で出力があったものは未読になる
    await js(`window.__terp.activate(${id1})`);
    await send(id2, 'echo background\r');
    await sleep(3000);
    const state2 = await js(`window.__terp.sessions.get(${id2}).li.dataset.state`);
    check('裏の出力で未読の印が付く', state2 === 'unread', state2);

    // claude の題名: /bin/sleep に claude という名前のリンクを付けて claude のふりをさせ、
    // 作業中（◐）→ 入力待ち（✳）のタイトルを流す。本物の claude は動かさない
    const fake = path.join(outDir, 'bin');
    fs.mkdirSync(fake, { recursive: true });
    fs.rmSync(path.join(fake, 'claude'), { force: true });
    fs.symlinkSync('/bin/sleep', path.join(fake, 'claude'));
    await send(
      id2,
      `(sleep 4; printf '\\e]0;✳ テストの作業\\a') & printf '\\e]0;◐ テストの作業\\a'; ${fake}/claude 7\r`,
    );
    await sleep(3000);
    const nameOf = (id) => js(`window.__terp.sessions.get(${id}).li.querySelector('.session__name').textContent`);
    const stateOf = (id) => js(`window.__terp.sessions.get(${id}).li.dataset.state`);
    const busyName = await nameOf(id2);
    check('claude の題名が一覧の名前になる', busyName === 'テストの作業', busyName);
    const busyState = await stateOf(id2);
    check('題名の回転の記号で出力中になる', busyState === 'busy', busyState);
    await sleep(2500);
    const doneState = await stateOf(id2);
    check('応答が終わったら通知の印が付く', doneState === 'notify', doneState);
    // 作業場所とプログラム名は 1.5 秒ごとに拾うため、抜けたのが伝わるまで待つ
    let shellName = '';
    for (let t = 0; t < 40 && shellName !== 'terp'; t++) {
      await sleep(250);
      shellName = await nameOf(id2);
    }
    check('claude を抜けたらフォルダ名に戻る', shellName === 'terp', shellName);

    // ⌘W 相当で3枚目を閉じる
    await js(`window.__terp.activate(${id3})`);
    win.webContents.send('menu', 'close');
    await sleep(1500);
    const count = await js('window.__terp.sessions.size');
    check('閉じると一覧から消える', count === 2, `残り ${count}`);
    const afterClose = await js('window.__terp.activeId');
    check('閉じた後は直前のターミナルへ戻る', afterClose === id1, `表示中 ${afterClose}`);

    // ⌘V 相当の貼り付けと、⌘C 相当のコピー
    await clipboard.writeText('echo pasted-ok');
    win.webContents.paste();
    await sleep(300);
    await send(id1, '\r');
    await sleep(1000);
    check('貼り付けがシェルに届く', /\npasted-ok/.test(await buffer(id1)));
    await js(`window.__terp.sessions.get(${id1}).term.selectAll()`);
    win.webContents.copy();
    await sleep(300);
    check('コピーで選択範囲がクリップボードに入る', (await clipboard.readText()).includes('pasted-ok'));
    await clipboard.writeText(savedClipboard);

    await js(`window.__terp.sessions.get(${id1}).term.clearSelection()`);
    await sleep(500);
    fs.writeFileSync(path.join(outDir, 'screen.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
    await finish();
  });
};
