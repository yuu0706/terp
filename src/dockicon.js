const { iconSvg, iconColors, DEFAULT_ICON_COLORS } = require('./themeicon');

function createDockIcon({ app, BrowserWindow }) {
  let pending = null;
  let running = false;
  let stopped = false;
  let lastKey = '';
  let lastColors = null;
  let lastImage = null;
  let renderCount = 0;
  let drawingWindow = null;

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
        const colors = pending;
        const key = JSON.stringify(colors);
        pending = null;
        if (key === lastKey) continue;
        try {
          renderCount++;
          const image = await render(colors);
          // 描いている間に変わった色は当てず、最後に届いた色だけを次に描く
          if (stopped || (pending && JSON.stringify(pending) !== key)) continue;
          if (image.isEmpty()) continue;
          app.dock.setIcon(image);
          lastKey = key;
          lastColors = colors;
          lastImage = image;
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
    pending = loaded.themedIcon === false ? { ...DEFAULT_ICON_COLORS } : iconColors(loaded.chrome);
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
  };
}

module.exports = { createDockIcon };
