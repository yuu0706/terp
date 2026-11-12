const { iconSvg, iconColors, DEFAULT_ICON_COLORS } = require('./themeicon');
const { bundleIconTarget, setBundleIcon } = require('./bundleicon');

// appliedStore（bundleicon.js の createAppliedStore）を渡すと、前の起動で貼った絵が残っていれば貼り直さない
function createDockIcon({ app, BrowserWindow, applyBundleIcon = setBundleIcon, appliedStore = null }) {
  let pending = null;
  let running = false;
  let stopped = false;
  let lastKey = '';
  let lastColors = null;
  let lastImage = null;
  let renderCount = 0;
  let drawingWindow = null;
  let lastBundleKey = '';
  let bundleTarget = null;
  let bundleApplyCount = 0;
  let bundleRemoved = null;
  // この起動でアプリのフォルダの絵を変えたか。変えたら、閉じた後に Dock を作り直す（main.js）
  let bundleChanged = false;

  async function render(colors) {
    const target = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });
    drawingWindow = target;
    try {
      const html = `<html><body style="margin:0;background:transparent">${iconSvg(colors)}</body></html>`;
      await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      // 読み込みの完了だけでは最初の描画が終わっていないため、原本の生成と同じだけ待つ
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (await target.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 });
    } finally {
      if (!target.isDestroyed()) target.destroy();
      drawingWindow = null;
    }
  }

  async function drain() {
    running = true;
    try {
      while (pending && !stopped) {
        const request = pending;
        const { colors, remove } = request;
        const key = JSON.stringify(colors);
        const bundleKey = JSON.stringify(request);
        pending = null;
        if (key === lastKey && bundleKey === lastBundleKey) continue;
        try {
          let image = lastImage;
          if (key !== lastKey) {
            renderCount++;
            image = await render(colors);
          }
          // 描いている間に変わった色は当てず、最後に届いた色だけを次に描く
          if (stopped || (pending && JSON.stringify(pending) !== bundleKey)) continue;
          if (image.isEmpty()) continue;
          if (key !== lastKey) {
            app.dock.setIcon(image);
            lastKey = key;
            lastColors = colors;
            lastImage = image;
          }
          const target = bundleIconTarget({ isPackaged: app.isPackaged });
          if (target && bundleKey !== lastBundleKey && !(lastBundleKey === '' && appliedStore?.applied(target, bundleKey, remove))) {
            await applyBundleIcon(target, remove ? null : image.toPNG(), remove);
            appliedStore?.save(target, bundleKey);
            bundleTarget = target;
            bundleApplyCount++;
            bundleRemoved = remove;
            bundleChanged = true;
          }
          lastBundleKey = bundleKey;
        } catch (_) {
          // アイコンの失敗で端末を止めない。成功した色だけ覚え、次の変更でまた試す
        }
      }
    } finally {
      running = false;
    }
  }

  function update(loaded) {
    if (!app.dock || stopped) return;
    const remove = loaded.themedIcon === false;
    pending = { colors: remove ? { ...DEFAULT_ICON_COLORS } : iconColors(loaded.chrome), remove };
    if (!running) void drain();
  }

  function stop() {
    stopped = true;
    pending = null;
    if (drawingWindow && !drawingWindow.isDestroyed()) drawingWindow.destroy();
  }

  return {
    update,
    stop,
    get colors() { return lastColors && { ...lastColors }; },
    get renderCount() { return renderCount; },
    get busy() { return running; },
    get png() { return lastImage?.toPNG() || null; },
    get bundleTarget() { return bundleTarget; },
    get bundleApplyCount() { return bundleApplyCount; },
    get bundleRemoved() { return bundleRemoved; },
    get bundleChanged() { return bundleChanged; },
  };
}

module.exports = { createDockIcon };
