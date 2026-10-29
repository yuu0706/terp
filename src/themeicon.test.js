const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { iconSvg, iconColors, DEFAULT_ICON_COLORS } = require('./themeicon');
const { createDockIcon } = require('./dockicon');

const original = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
const custom = { top: '#123456', bottom: '#234567', accent: '#345678', muted: '#456789', text: '#56789a' };
const chrome = { 'term-bg': custom.top, bg: custom.bottom, accent: custom.accent, 'text-muted': custom.muted, text: custom.text };

test('原本の5色なら原本と同じ図形と透明度になる', () => {
  assert.equal(iconSvg(DEFAULT_ICON_COLORS), original);
});

test('図形と透明度を保ったまま5色だけを差し替える', () => {
  let expected = original;
  for (const key of Object.keys(DEFAULT_ICON_COLORS)) expected = expected.replaceAll(DEFAULT_ICON_COLORS[key], custom[key]);
  assert.equal(iconSvg(custom), expected);
});

test('誤った色はその1色だけ原本の色に戻す', () => {
  for (const key of Object.keys(DEFAULT_ICON_COLORS)) {
    for (const value of [undefined, null, 123456, '#abc', '#12345678', 'rgba(1,2,3,1)', 'red', '#zzzzzz', '#123456\n', '"><script>']) {
      assert.equal(iconSvg({ ...custom, [key]: value }), iconSvg({ ...custom, [key]: DEFAULT_ICON_COLORS[key] }));
    }
  }
  assert.equal(iconSvg(), original);
  assert.equal(iconSvg(null), original);
  assert.equal(iconSvg({ ...custom, text: '#ABCDEF' }), iconSvg({ ...custom, text: '#abcdef' }));
});

test('アプリの枠の色をアイコンの5色に対応させる', () => {
  assert.deepEqual(iconColors(chrome), custom);
  assert.deepEqual(iconColors(), DEFAULT_ICON_COLORS);
  for (const [source, key] of [['term-bg', 'top'], ['bg', 'bottom'], ['accent', 'accent'], ['text-muted', 'muted'], ['text', 'text']]) {
    assert.deepEqual(iconColors({ ...chrome, [source]: 'rgba(0,0,0,0)' }), { ...custom, [key]: DEFAULT_ICON_COLORS[key] });
  }
});

test('上下が同じ色なら明暗どちらのテーマでも下を少し濃くする', () => {
  for (const value of ['#444444', '#fafafa', '#000001']) {
    const colors = iconColors({ ...chrome, 'term-bg': value, bg: value.toUpperCase() });
    assert.equal(colors.top, value);
    assert.ok(parseInt(colors.bottom.slice(1), 16) < parseInt(value.slice(1), 16));
    assert.deepEqual({ ...colors, top: custom.top, bottom: custom.bottom }, custom);
  }
  const black = iconColors({ ...chrome, 'term-bg': '#000000', bg: '#000000' });
  assert.equal(black.top, '#000000');
  assert.notEqual(black.bottom, black.top);
  assert.match(black.bottom, /^#[0-9a-f]{6}$/);
});

test('themedIcon は既定で有効、真偽だけ保存でき、誤った設定は既定に戻る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-theme-icon-'));
  const previous = process.env.TERP_CONFIG_DIR;
  process.env.TERP_CONFIG_DIR = dir;
  try {
    const config = require('./config');
    config.ensureConfigFile();
    assert.equal(config.rawConfig().themedIcon, true);
    assert.equal(config.loadConfig().themedIcon, true);
    config.updateConfig({ themedIcon: false });
    assert.equal(config.loadConfig().themedIcon, false);
    config.updateConfig({ themedIcon: true });
    assert.equal(config.loadConfig().themedIcon, true);
    for (const value of ['false', 0, 1, [], {}]) assert.throws(() => config.updateConfig({ themedIcon: value }));
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ themedIcon: 'false' }));
    assert.equal(config.loadConfig().themedIcon, true);
    assert.match(config.loadConfig().error, /themedIcon/);
    config.updateConfig({ themedIcon: null });
    assert.equal(config.loadConfig().themedIcon, true);
  } finally {
    if (previous === undefined) delete process.env.TERP_CONFIG_DIR;
    else process.env.TERP_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeDock(options = {}) {
  const windows = [];
  const applied = [];
  const bundleApplied = [];
  let active = 0;
  let maximum = 0;
  const control = { failLoad: false, failCapture: false, failApply: false, failBundle: false, loading: null, bundling: null };
  function BrowserWindow(options) {
    const target = this;
    target.options = options;
    target.destroyed = false;
    active++;
    maximum = Math.max(maximum, active);
    windows.push(target);
    target.loadURL = async (url) => {
      target.html = decodeURIComponent(url.split(',').slice(1).join(','));
      if (control.failLoad) throw new Error('load failed');
      if (control.loading) await control.loading;
    };
    target.webContents = {
      capturePage: async (bounds) => {
        assert.deepEqual(bounds, { x: 0, y: 0, width: 1024, height: 1024 });
        if (control.failCapture) throw new Error('capture failed');
        return {
          resize: (size) => {
            assert.deepEqual(size, { width: 1024, height: 1024 });
            return { isEmpty: () => false, toPNG: () => Buffer.from(target.html) };
          },
        };
      },
    };
    target.isDestroyed = () => target.destroyed;
    target.destroy = () => { target.destroyed = true; active--; };
  }
  const app = { dock: { setIcon: (image) => {
    if (control.failApply) throw new Error('setIcon failed');
    applied.push(image.toPNG().toString());
  } } };
  const applyBundleIcon = async (target, png, remove) => {
    if (control.bundling) await control.bundling;
    if (control.failBundle) throw new Error('bundle failed');
    bundleApplied.push({ target, png, remove });
  };
  return { icon: createDockIcon({ app, BrowserWindow, applyBundleIcon, ...options }), windows, applied, bundleApplied, control, get maximum() { return maximum; } };
}

async function settled(icon) {
  for (let t = 0; t < 5000 && icon.busy; t += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(icon.busy, false, '描画が終了する');
}

test('同じ5色では描き直さず、無効と再有効で原本とテーマに戻す', async () => {
  const { icon, windows, applied } = fakeDock();
  const loaded = { themedIcon: true, chrome };
  icon.update(loaded);
  await settled(icon);
  assert.deepEqual(icon.colors, custom);
  assert.equal(icon.renderCount, 1);
  assert.ok(icon.png.length > 0);
  const copy = icon.colors;
  copy.text = '#000000';
  assert.deepEqual(icon.colors, custom);
  icon.update({ ...loaded, fontSize: 17 });
  await settled(icon);
  assert.equal(icon.renderCount, 1);
  icon.update({ ...loaded, themedIcon: false });
  await settled(icon);
  assert.deepEqual(icon.colors, DEFAULT_ICON_COLORS);
  icon.update(loaded);
  await settled(icon);
  assert.deepEqual(icon.colors, custom);
  assert.equal(applied.length, 3);
  assert.ok(windows.every((w) => w.destroyed));
  for (const w of windows) {
    assert.deepEqual(w.options, {
      width: 1024, height: 1024, show: false, transparent: true, frame: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });
  }
});

test('描画中の変更は最後の色だけを描き、窓を重ねない', async () => {
  const fake = fakeDock();
  let release;
  fake.control.loading = new Promise((resolve) => { release = resolve; });
  fake.icon.update({ chrome });
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  fake.icon.update({ chrome: { ...chrome, accent: '#445566' } });
  assert.equal(fake.windows.length, 1);
  release();
  await settled(fake.icon);
  assert.equal(fake.maximum, 1);
  assert.equal(fake.windows.length, 2);
  assert.equal(fake.applied.length, 1);
  assert.equal(fake.icon.colors.accent, '#445566');
  assert.ok(fake.windows.every((w) => !w.html.includes('#112233') && w.destroyed));
});

test('描画中に元の色へ戻したら余分な描き直しと古い色の適用をしない', async () => {
  const fake = fakeDock();
  fake.icon.update({ chrome });
  await settled(fake.icon);
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.deepEqual(fake.icon.colors, custom);
  assert.equal(fake.icon.renderCount, 2);
  assert.equal(fake.applied.length, 1);
});

test('読み込み・撮影・Dock の失敗は無視し、次の変更で同じ色も再試行する', async () => {
  for (const failure of ['failLoad', 'failCapture', 'failApply']) {
    const fake = fakeDock();
    fake.control[failure] = true;
    fake.icon.update({ chrome });
    await settled(fake.icon);
    assert.equal(fake.icon.colors, null);
    assert.ok(fake.windows.every((w) => w.destroyed));
    fake.control[failure] = false;
    fake.icon.update({ chrome });
    await settled(fake.icon);
    assert.deepEqual(fake.icon.colors, custom);
    assert.equal(fake.icon.renderCount, 2);
    assert.ok(fake.windows.every((w) => w.destroyed));
  }
});

test('Dock が無い環境では窓を作らない', () => {
  const icon = createDockIcon({ app: {}, BrowserWindow: () => assert.fail('窓は不要') });
  icon.update({ chrome });
  assert.equal(icon.renderCount, 0);
  assert.equal(icon.colors, null);
});

test('終了時は描画用の窓と待機中の変更を破棄する', async () => {
  const fake = fakeDock();
  fake.icon.update({ chrome });
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  fake.icon.stop();
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.equal(fake.applied.length, 0);
  assert.equal(fake.windows.length, 1);
  assert.ok(fake.windows[0].destroyed);
});

function fakeBundle(t, options) {
  const previous = process.env.TERP_BUNDLE_ICON_TARGET;
  process.env.TERP_BUNDLE_ICON_TARGET = path.join(os.tmpdir(), 'terp-bundle-test', 'Fake.app');
  t.after(() => {
    if (previous === undefined) delete process.env.TERP_BUNDLE_ICON_TARGET;
    else process.env.TERP_BUNDLE_ICON_TARGET = previous;
  });
  return fakeDock(options);
}

test('起動時と色の変更で同じ PNG を貼り、同じ色では貼らず、無効で外す', async (t) => {
  const fake = fakeBundle(t);
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleTarget, process.env.TERP_BUNDLE_ICON_TARGET);
  assert.equal(fake.icon.bundleApplyCount, 1);
  assert.equal(fake.icon.bundleRemoved, false);
  assert.deepEqual(fake.bundleApplied[0].png, fake.icon.png);
  fake.icon.update({ chrome, fontSize: 17 });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 1);
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 2);
  assert.deepEqual(fake.bundleApplied[1].png, fake.icon.png);
  fake.icon.update({ chrome, themedIcon: false });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 3);
  assert.equal(fake.icon.bundleRemoved, true);
  assert.equal(fake.bundleApplied[2].png, null);
  fake.icon.update({ chrome, themedIcon: false, fontSize: 18 });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 3);
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 4);
  assert.equal(fake.icon.bundleRemoved, false);
  const restarted = fakeDock();
  restarted.icon.update({ chrome });
  await settled(restarted.icon);
  assert.equal(restarted.icon.bundleApplyCount, 1);
});

test('5色が原本と同じでも切り替えで貼り付けと解除を行い、描き直さない', async (t) => {
  const fake = fakeBundle(t);
  fake.icon.update({});
  await settled(fake.icon);
  fake.icon.update({ themedIcon: false });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleRemoved, true);
  fake.icon.update({ themedIcon: true });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleRemoved, false);
  assert.equal(fake.icon.bundleApplyCount, 3);
  assert.equal(fake.icon.renderCount, 1);
});

test('貼り付けと解除の失敗は Dock を止めず、次の同じ色の設定変更で再試行する', async (t) => {
  const fake = fakeBundle(t);
  fake.control.failBundle = true;
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.deepEqual(fake.icon.colors, custom);
  assert.equal(fake.icon.bundleApplyCount, 0);
  assert.equal(fake.icon.bundleTarget, null);
  fake.control.failBundle = false;
  fake.icon.update({ chrome, fontSize: 17 });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 1);
  fake.control.failBundle = true;
  fake.icon.update({ themedIcon: false });
  await settled(fake.icon);
  assert.deepEqual(fake.icon.colors, DEFAULT_ICON_COLORS);
  assert.equal(fake.icon.bundleRemoved, false);
  fake.control.failBundle = false;
  fake.icon.update({ themedIcon: false, fontSize: 18 });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleRemoved, true);
  assert.equal(fake.icon.bundleApplyCount, 2);
});

test('貼り付け中の設定変更も直列に処理し、最後の状態へ追いつく', async (t) => {
  const fake = fakeBundle(t);
  let release;
  fake.control.bundling = new Promise((resolve) => { release = resolve; });
  fake.icon.update({ chrome });
  for (let i = 0; i < 200 && fake.applied.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.applied.length, 1);
  assert.equal(fake.icon.busy, true);
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  fake.icon.update({ themedIcon: false });
  release();
  await settled(fake.icon);
  assert.deepEqual(fake.bundleApplied.map((entry) => entry.remove), [false, true]);
  assert.equal(fake.icon.bundleRemoved, true);
  assert.deepEqual(fake.icon.colors, DEFAULT_ICON_COLORS);
});

test('前の起動で同じ絵を貼っていれば貼り直さず、Dock の作り直しも求めない。色を変えたら貼って求める', async (t) => {
  const saved = [];
  const fake = fakeBundle(t, { appliedStore: { applied: () => true, save: (target, key) => saved.push(key) } });
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 0);
  assert.equal(fake.icon.bundleChanged, false);
  assert.equal(fake.applied.length, 1, 'Dock の起動中の絵は描く');
  fake.icon.update({ chrome: { ...chrome, accent: '#112233' } });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 1);
  assert.equal(fake.icon.bundleChanged, true);
  assert.equal(saved.length, 1);
});

test('控えが合わなければ起動時に貼り、Dock の作り直しを求める', async (t) => {
  const fake = fakeBundle(t, { appliedStore: { applied: () => false, save: () => {} } });
  fake.icon.update({ chrome });
  await settled(fake.icon);
  assert.equal(fake.icon.bundleApplyCount, 1);
  assert.equal(fake.icon.bundleChanged, true);
});
