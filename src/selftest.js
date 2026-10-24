// TERP_SELFTEST=<出力先> で起動すると、操作を流して画面と文字を書き出し、終了する
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TERP_SELFTEST_SETTINGS を付けると、設定の画面（左のメニュー・各項目の保存と反映・Esc で閉じる）を確かめる
async function runSettingsTest({ win, js, check, outDir }) {
  const { CONFIG_PATH } = require('./config');
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const shot = (name) => win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()));
  // 設定ファイルに画面に無い値を書いておき、画面で変えても消えないことを見る
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...saved(), agents: [{ command: 'keep-me' }] }, null, 2));
  await sleep(1200);

  win.webContents.send('menu', 'settings');
  await sleep(800);
  check('⌘, で設定の画面が開く', (await js(`document.getElementById('settings').hidden`)) === false);
  const navs = await js(`[...document.querySelectorAll('#settings-nav .settings__nav-item')].map((b) => b.textContent)`);
  check('左にメニューが並ぶ', navs.join() === '外観,AI エージェント,詳しい設定', navs.join());
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
  const repo = path.join(outDir, 'files-repo');
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

// TERP_SELFTEST_PATHLINKS を付けると、実在確認・折り返し・ファイルの行と桁への移動を確かめる
async function runPathLinksTest({ js, check, outDir }) {
  const dir = fs.mkdtempSync(path.join(path.resolve(outDir), 'pathlinks-'));
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
  const fake = path.join(outDir, 'fake agent');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(fake, '#!/bin/sh\necho "fake-agent-started $*"\nsleep 3\n', { mode: 0o755 });
  const commands = () => js(`[...document.querySelectorAll('#agents .btn--agent')].map((b) => b.dataset.command)`);
  const found = await commands();
  check('入っている claude と codex のボタンが出る', found.includes('claude') && found.includes('codex'), found.join(', '));

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config.agents = [
    { command: fake, label: 'Fake Agent', args: '--hello', bypassArgs: '--skip-checks' },
    { command: 'no-such-agent-cli', label: '入っていない' },
  ];
  config.skipApprovals = true;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  await sleep(1200);
  await js('window.__terp.refreshAgents()');
  const after = await commands();
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
  check('＋ のプルダウンにターミナルとエージェント全部が出る', menu[0] === 'ターミナル' && ['claude', 'codex', 'fake agent'].every((n) => menu.includes(n)), menu.join(', '));
  const tagged = await js(`document.querySelector('#tab-menu [data-command="claude"] .session__bypass')?.textContent || ''`);
  check('プルダウンに確認なしの印が出る', tagged === '確認なし');
  const countBefore = await js('window.__terp.sessions.size');
  await js(`[...document.querySelectorAll('#tab-menu .menu__item')].find((b) => b.dataset.command === ${JSON.stringify(fake)}).click()`);
  await sleep(2500);
  const menuId = await js('window.__terp.activeId');
  check('プルダウンで選ぶと起動する', (await js('window.__terp.sessions.size')) === countBefore + 1 && /fake-agent-started --hello --skip-checks/.test(await js(`window.__terp.bufferText(${menuId})`)));
  check('選んだらプルダウンが閉じる', await js(`document.getElementById('tab-menu').hidden`));

  // メインのエージェントのボタン: 既定は見つかった最初のもの。設定の mainAgent で変えられる
  check('メインのボタンは既定で最初のエージェント', (await js(`document.getElementById('tab-main-agent').dataset.command`)) === 'claude');
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.mainAgent = fake;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  await sleep(1500);
  check('設定の mainAgent でメインを変えられる', (await js(`document.getElementById('tab-main-agent').dataset.command`)) === fake);
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

// TERP_SELFTEST_PERSIST=1→2→3 の順に、同じ TERP_CONFIG_DIR で3回起動して、セッションの保持を確かめる。
// 1: 印を付けて終わる / 2: 開き直してもシェルが生きている。常駐のプロセスを止める（Mac の再起動に当たる）/
// 3: 控えから同じ場所・名前で開き直す
async function runPersistTest({ js, check, outDir, phase }) {
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
    fs.writeFileSync(statePath, JSON.stringify({ files, order: await order(), layout }));
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
  check('3回目: 名前が戻る', name === '保持テスト', name);
  check('3回目: シェルは新しい（前の変数は無い）', !(await buffer(id)).includes('mark=persist-ok'));
}

// TERP_SELFTEST_WORK を付けると、一時フォルダに git のリポジトリを作り、作業（worktree）の
// 追加・作成・振り分け・削除を確かめる。TERP_CONFIG_DIR に一時フォルダを指定すること
async function runWorkTest({ win, js, check, outDir }) {
  const { execFileSync } = require('child_process');
  const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const repo = path.join(outDir, 'sample-repo');
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

  await writeConfig({ theme: 'Sakura Night' });
  const accent = await js('window.__terp.config.chrome.accent');
  check('テーマ名だけで Ghostty のテーマが読める', accent === '#ff9ebb', `強調色 ${accent}`);
  const termFg = await js(`window.__terp.sessions.get(${id}).term.options.theme.foreground`);
  check('開いている端末にも反映される', termFg === '#f5d5de', `文字色 ${termFg}`);
  const btnColor = await js(`getComputedStyle(document.getElementById('new-terminal')).backgroundColor`);
  check('新規ボタンが強調色になる', btnColor === 'rgb(255, 158, 187)', btnColor);
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
  const { setBlur } = require('./blur');
  check('窓の後ろのぼかしの関数が通る', setBlur(win, 20) === true);
  check('ぼかしを外せる', setBlur(win, 0) === true);
  await shoot('3-sakura-transparent');

  await writeConfig({ theme: 'Sakura Night', accent: '#ff69b4' });
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
