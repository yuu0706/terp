const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleIconTarget, bundleIconArgs, setBundleIcon, createAppliedStore, dockRefreshArgs, refreshDockAfterExit } = require('./bundleicon');

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

test('控えと同じ絵が貼れたままなら貼り直さず、入れ直して絵が消えたら貼り直す', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-applied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'Fake.app');
  fs.mkdirSync(target);
  const store = createAppliedStore(path.join(dir, 'bundle-icon.json'));
  assert.equal(store.applied(target, 'k1', false), false);
  store.save(target, 'k1');
  assert.equal(store.applied(target, 'k1', false), false, '絵が無ければ貼り直す');
  fs.writeFileSync(path.join(target, 'Icon\r'), '');
  assert.equal(store.applied(target, 'k1', false), true);
  assert.equal(store.applied(target, 'k2', false), false, '色が変われば貼り直す');
  assert.equal(store.applied(path.join(dir, 'Other.app'), 'k1', false), false, '別のアプリには貼り直す');
  store.save(target, 'k3');
  assert.equal(store.applied(target, 'k3', true), false, '外した控えなのに絵が残っていれば外し直す');
  fs.rmSync(path.join(target, 'Icon\r'));
  assert.equal(store.applied(target, 'k3', true), true);
});

test('Dock の作り直しは terp が終わるのを待ってから、切り離した子で行う', () => {
  const args = dockRefreshArgs(4321);
  assert.equal(args[0], '-c');
  assert.match(args[1], /kill -0 4321 /);
  assert.match(args[1], /\/usr\/bin\/killall Dock$/);
  assert.match(dockRefreshArgs('1; rm -rf /')[1], /kill -0 NaN /, 'pid は数として埋める');
  const calls = [];
  let unref = false;
  refreshDockAfterExit(99, (file, argv, options) => { calls.push({ file, argv, options }); return { unref: () => { unref = true; } }; });
  assert.equal(calls[0].file, '/bin/sh');
  assert.deepEqual(calls[0].argv, dockRefreshArgs(99));
  assert.equal(calls[0].options.detached, true);
  assert.ok(unref);
});
