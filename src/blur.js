// 窓の後ろをぼかす。Electron の vibrancy は不透明に近い板を敷くため使わず、
// Ghostty と同じ macOS の非公開の関数 CGSSetWindowBackgroundBlurRadius を呼ぶ。
// 非公開の関数のため、macOS の更新で消えたら何もしない（透過だけ残る）
let api = null;

function load() {
  if (api !== null) return api;
  try {
    const koffi = require('koffi');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    api = {
      connection: cg.func('int CGSMainConnectionID(void)'),
      setRadius: cg.func('int CGSSetWindowBackgroundBlurRadius(int, uint32_t, uint32_t)'),
    };
  } catch {
    api = false;
  }
  return api;
}

// 成功したら true。radius は 0 でぼかしを外す
function setBlur(win, radius) {
  const fns = load();
  if (!fns) return false;
  // getMediaSourceId は "window:<CGWindowID>:0" の形
  const windowId = Number(win.getMediaSourceId().split(':')[1]);
  return fns.setRadius(fns.connection(), windowId, radius) === 0;
}

module.exports = { setBlur };
