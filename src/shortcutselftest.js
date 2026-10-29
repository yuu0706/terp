const fs = require('fs');
const os = require('os');
const path = require('path');
const { Menu } = require('electron');
const config = require('./config');
const shortcuts = require('./shortcuts');

// 実際の打鍵を使い、待ち受け中にメニューが先に動く不具合も検出する。
exports.run = async ({ win, js, check, outDir }) => {
  const temporaryRoots = [os.tmpdir(), '/tmp'].map((dir) => fs.realpathSync(dir));
  const target = fs.realpathSync(config.CONFIG_DIR);
  if (!process.env.TERP_CONFIG_DIR || !temporaryRoots.some((root) => {
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  })) throw new Error('ショートカットの自己診断には一時フォルダ内の TERP_CONFIG_DIR が必要');

  const original = fs.readFileSync(config.CONFIG_PATH, 'utf8');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (fn, name) => {
    for (let i = 0; i < 80; i++) {
      if (await fn()) return true;
      await sleep(100);
    }
    throw new Error(`待機の上限: ${name}`);
  };
  // 画面への設定の知らせは本体のメニューの作り直しより後に届くため、画面の表示は待ってから確かめる
  const settled = async (code) => {
    for (let i = 0; i < 30; i++) {
      if (await js(code)) return true;
      await sleep(100);
    }
    return false;
  };
  const saved = () => JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8')).keybindings || {};
  const item = (id) => Menu.getApplicationMenu().getMenuItemById(id);
  const row = (id) => `document.querySelector('[data-shortcut-id="${id}"]')`;
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(100);
  };
  const begin = async (id) => {
    await js(`${row(id)}.querySelector('[data-shortcut-key]').focus(); ${row(id)}.querySelector('[data-shortcut-key]').click()`);
    await wait(() => js(`document.getElementById('shortcut-status').textContent === 'キーを押してください（Esc で取り消す）'`), 'キーの待ち受け');
  };
  const capture = async (id, key, modifiers, expected) => {
    await begin(id);
    await press(key, modifiers);
    await wait(() => saved()[id] === expected, `${id} の保存`);
    await wait(() => js(`document.getElementById('shortcut-status').textContent === '保存した'`), '保存の完了');
  };
  const menuKey = (id) => shortcuts.normalizeAccelerator(item(id)?.accelerator);
  try {
    config.updateConfig({ keybindings: {} });
    await wait(() => menuKey('new') === 'Command+T', '既定のメニュー');
    await js(`window.__terp.openSettings('shortcuts')`);
    check('設定にショートカットの区分と全メニューの操作が出る', await js(`document.querySelector('.settings__title').textContent === 'ショートカット' && document.querySelectorAll('[data-shortcut-id]').length === ${shortcuts.ALL_SHORTCUTS.filter((entry) => !entry.aliasFor).length}`));
    check('OS 標準のコピーは変更操作を出さない', await js(`${row('role-copy')}.textContent.includes('⌘C') && !${row('role-copy')}.querySelector('button')`));
    await js(`(() => { const filter = document.getElementById('shortcut-filter'); filter.value = 'ワークスペース'; filter.dispatchEvent(new Event('input')); })()`);
    check('区分と操作名で絞り込める', await js(`[...document.querySelectorAll('[data-shortcut-id]')].filter((entry) => !entry.hidden).every((entry) => entry.textContent.includes('ワークスペース')) && ${row('new')}.hidden`));
    await js(`(() => { const filter = document.getElementById('shortcut-filter'); filter.value = '見つからない操作'; filter.dispatchEvent(new Event('input')); })()`);
    check('該当なしで絞り込みの変更を案内する', await js(`document.querySelector('.shortcut-settings').textContent.includes('該当する操作なし') && !document.querySelector('.shortcut-settings__list').nextElementSibling.hidden`));
    await js(`(() => { const filter = document.getElementById('shortcut-filter'); filter.value = ''; filter.dispatchEvent(new Event('input')); })()`);
    // 一覧を下へ送り、上に貼り付いた絞り込みの帯の上下から行が覗かないことを確かめる
    await js(`document.querySelector('.settings__content').scrollTop = 600`);
    await sleep(200);
    check('一覧を送っても、絞り込みの帯は枠の上端に貼り付く', await js(`(() => {
      const bar = document.querySelector('.shortcut-settings__toolbar').getBoundingClientRect();
      const box = document.querySelector('.settings__content').getBoundingClientRect();
      return Math.abs(bar.top - box.top) <= 1;
    })()`));
    fs.writeFileSync(path.join(outDir, 'shortcuts-list.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.settings__content').scrollTop = 0`);

    await begin('new');
    await press('T');
    check('修飾キーのない打鍵は保存しない', !Object.keys(saved()).length && await js(`document.getElementById('shortcut-error').textContent.includes('組み合わせる')`));
    await press('Escape');
    check('Esc は設定を閉じず、キーの待ち受けだけ取り消す', await js(`!document.getElementById('settings').hidden && !document.documentElement.dataset.shortcutCapture`));
    const count = await js('window.__terp.sessions.size');
    await begin('new');
    await press('W', ['meta']);
    check('重なる ⌘W はタブを閉じず、相手を示して保存しない', !Object.keys(saved()).length && await js(`window.__terp.sessions.size === ${count} && document.getElementById('shortcut-error').textContent.includes('タブを閉じる')`));
    await press('C', ['meta']);
    check('OS 標準のキーとの重なりも保存しない', !Object.keys(saved()).length && await js(`document.getElementById('shortcut-error').textContent.includes('コピー')`));
    await press('Escape');
    await capture('new', 'T', ['control', 'alt'], 'Control+Alt+T');
    await wait(() => menuKey('new') === 'Control+Alt+T', 'メニューへの反映');
    check('変更を設定ファイル・メニュー・ボタンのヒントに反映する', await settled(`document.querySelector('#new-terminal [data-shortcut-key]').textContent === '⌃⌥T' && ${row('new')}.querySelector('[data-shortcut-key]').textContent === '⌃⌥T'`), JSON.stringify(await js(`[document.querySelector('#new-terminal [data-shortcut-key]')?.textContent, ${row('new')}.querySelector('[data-shortcut-key]')?.textContent, window.__terp.config.keybindings]`)));

    await js(`document.getElementById('settings-close').click()`);
    await press('T', ['control', 'alt']);
    await wait(() => js(`window.__terp.sessions.size === ${count + 1}`), '変更後のキーで新規作成');
    await press('T', ['meta']);
    await sleep(300);
    check('変更後のキーで新規作成し、元のキーでは作成しない', await js(`window.__terp.sessions.size === ${count + 1}`));
    await js(`window.__terp.openSettings('shortcuts')`);

    await js(`${row('new')}.querySelector('[data-shortcut-unset]').click()`);
    await wait(() => saved().new === null && !item('new').accelerator, '割り当ての解除');
    check('割り当てを外すとメニューとヒントも消える', await settled(`${row('new')}.querySelector('[data-shortcut-key]').textContent === '割り当てなし' && document.querySelector('#new-terminal [data-shortcut-key]').textContent === ''`));
    await js(`${row('new')}.querySelector('[data-shortcut-reset]').click()`);
    await wait(() => !Object.hasOwn(saved(), 'new') && menuKey('new') === 'Command+T', '単一項目の復元');
    check('項目を既定に戻すと上書きを除去する', await settled(`${row('new')}.querySelector('[data-shortcut-key]').textContent === '⌘T'`));

    await capture('new', 'T', ['control', 'alt'], 'Control+Alt+T');
    await capture('close', 'T', ['meta'], 'Command+T');
    await js(`${row('new')}.querySelector('[data-shortcut-reset]').click()`);
    await wait(() => js(`document.getElementById('shortcut-error').textContent.includes('重なる')`), '復元時の重なり');
    check('既定に戻すと重なる場合も保存を止める', saved().new === 'Control+Alt+T' && saved().close === 'Command+T');
    await js(`document.getElementById('shortcut-reset-all').click()`);
    await wait(() => !Object.keys(saved()).length && menuKey('new') === 'Command+T' && menuKey('close') === 'Command+W', 'すべて復元');
    check('すべて既定に戻すと一覧・メニューを復元する', await js(`${row('new')}.querySelector('[data-shortcut-key]').textContent === '⌘T' && ${row('close')}.querySelector('[data-shortcut-key]').textContent === '⌘W'`));

    await capture('recent', 'Y', ['control', 'alt'], 'Control+Alt+Y');
    // 直前のタブは画面が自分で判定するため、新しい設定が画面に届くのを待ってから押す
    await wait(() => js(`window.__terp.config.keybindings.recent === 'Control+Alt+Y'`), '画面への反映');
    await js(`document.getElementById('settings-close').click()`);
    const active = await js('window.__terp.activeId');
    await press('Y', ['control', 'alt']);
    check('端末側で受ける直前のタブも変更後のキーに従う', await settled(`window.__terp.activeId !== ${active}`), JSON.stringify(await js(`({ active: window.__terp.activeId, key: window.__terp.activeKey, focus: document.activeElement?.className, tabs: window.__terp.tabOrder, kb: window.__terp.config.keybindings })`)));
    const switched = await js('window.__terp.activeId');
    await press('Tab', ['control']);
    check('変更後は元の ⌃Tab で直前のタブへ移らない', await js(`window.__terp.activeId === ${switched}`));

    config.updateConfig({ keybindings: { 'font-bigger': null } });
    await wait(() => !item('font-bigger').accelerator && !item('font-bigger-plus').accelerator, '文字拡大の解除');
    check('文字拡大を解除すると隠れた別キーも解除する', !item('font-bigger-plus').accelerator);
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ ...JSON.parse(original), keybindings: { new: 'Command+C', close: 10, save: null } }));
    await wait(() => menuKey('new') === 'Command+T' && menuKey('close') === 'Command+W' && !item('save').accelerator, '手書きの誤りの除去');
    check('手書きの誤りと重なりだけを既定に戻す', config.loadConfig().keybindings.save === null && Boolean(config.loadConfig().error));
    await js(`window.__terp.openSettings('shortcuts')`);
    fs.writeFileSync(path.join(outDir, 'shortcuts-settings.png'), (await win.webContents.capturePage()).toPNG());
    await begin('new');
    await js(`document.getElementById('settings-close').click()`);
    check('待ち受け中に設定を閉じると待ち受けを解除する', await js(`!document.documentElement.dataset.shortcutCapture`));
  } finally {
    await js(`document.getElementById('settings-close').click()`);
    fs.writeFileSync(config.CONFIG_PATH, original);
    const expected = config.loadConfig().keybindings;
    await wait(() => js(`JSON.stringify(window.__terp.config.keybindings) === ${JSON.stringify(JSON.stringify(expected))}`), '元の設定の復元');
  }
};
