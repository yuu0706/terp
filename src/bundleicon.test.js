const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleIconTarget, bundleIconArgs, setBundleIcon } = require('./bundleicon');

test('パッケージ版だけ実行ファイルから3つ上のアプリを選ぶ', () => {
  const execPath = '/Applications/terp.app/Contents/MacOS/terp';
  assert.equal(bundleIconTarget({ isPackaged: true, execPath, env: {} }), '/Applications/terp.app');
  assert.equal(bundleIconTarget({ isPackaged: false, execPath, env: {} }), null);
  assert.equal(bundleIconTarget({ isPackaged: true, execPath: '/tmp/terp/Contents/MacOS/terp', env: {} }), null);
  assert.equal(bundleIconTarget({ isPackaged: false, execPath: '/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', env: {} }), null);
});

test('自己診断の指定先はパッケージ版かどうかに関係なく優先する', () => {
  const target = path.join(os.tmpdir(), 'test icon', 'Fake.app');
  for (const isPackaged of [true, false]) {
    assert.equal(bundleIconTarget({ isPackaged, env: { TERP_BUNDLE_ICON_TARGET: target } }), target);
  }
});

test('JXA へパスを独立した引数で渡し、解除には空の画像パスを渡す', () => {
  const target = '/tmp/空 白 " \' $(touch unsafe).app';
  const png = '/tmp/絵 " \' `touch unsafe`\n.png';
  const args = bundleIconArgs(target, png);
  assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.deepEqual(args.slice(4), [target, png]);
  assert.equal(args[3], bundleIconArgs('/tmp/Other.app', '/tmp/other.png')[3]);
  assert.deepEqual(bundleIconArgs(target, null).slice(4), [target, '']);
});

test('Dock と同じ PNG を一時ファイルに書き、成功・false・実行失敗のすべてで消す', async () => {
  const png = Buffer.from('Dock に渡した PNG');
  for (const outcome of ['true\n', 'false\n', 'error']) {
    let pngPath;
    const operation = setBundleIcon('/tmp/Fake.app', png, false, async (file, args, options) => {
      assert.equal(file, '/usr/bin/osascript');
      assert.deepEqual(options, { timeout: 10000, encoding: 'utf8' });
      assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
      assert.equal(args[4], '/tmp/Fake.app');
      pngPath = args[5];
      assert.equal(path.dirname(path.dirname(pngPath)), os.tmpdir());
      assert.deepEqual(fs.readFileSync(pngPath), png);
      if (outcome === 'error') throw new Error('timeout');
      return { stdout: outcome };
    });
    if (outcome === 'true\n') await operation;
    else await assert.rejects(operation, outcome === 'error' ? /timeout/ : /アイコン/);
    assert.equal(fs.existsSync(path.dirname(pngPath)), false);
  }
});

test('解除では PNG を作らず nil を使う呼び出しへ進む', async () => {
  let called = false;
  await setBundleIcon('/tmp/Fake.app', null, true, async (file, args, options) => {
    called = true;
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args, bundleIconArgs('/tmp/Fake.app', ''));
    assert.equal(options.timeout, 10000);
    return { stdout: 'true\n' };
  });
  assert.equal(called, true);
});
