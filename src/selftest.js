// TERP_SELFTEST=<出力先> で起動すると、操作を流して画面と文字を書き出し、終了する
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    await sleep(2500);
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
      app.quit();
      return;
    }

    if (process.env.TERP_SELFTEST_WORK) {
      await runWorkTest({ win, js, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      app.quit();
      return;
    }

    if (process.env.TERP_SELFTEST_THEME) {
      await runThemeTest({ win, js, send, check, outDir });
      fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n') + '\n');
      app.quit();
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
    app.quit();
  });
};
