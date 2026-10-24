// 全画面のときに窓の後ろへ敷く、いまの壁紙。
// macOS の全画面は窓を専用の Space へ移し、後ろに壁紙も他の窓も無くなるため、透過しても灰色の板しか見えない。
// 壁紙を JPEG にして画面に敷き、透けて見えるようにする（全画面の Space には元々他の窓が無いので、見た目はほぼ透過と同じ）
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
// 長い辺の画素数。画面に敷いてぼかすため、これ以上は要らない
const MAX_SIDE = 2560;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// 窓のある画面の壁紙の場所。NSWorkspace に聞く（System Events を通さないため、操作の許可を求められない）
async function wallpaperPath(bounds) {
  const script = `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const x = ${Number(bounds.x) + Number(bounds.width) / 2};
let chosen = $.NSScreen.mainScreen;
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  if (x >= f.origin.x && x < f.origin.x + f.size.width) chosen = s;
}
ObjC.unwrap($.NSWorkspace.sharedWorkspace.desktopImageURLForScreen(chosen).path);`;
  return (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])).trim();
}

// HEIC などは画面で出せないため、sips で JPEG に変えて控えに置く。壁紙と更新時刻が同じなら使い回す
async function wallpaperDataUrl(bounds) {
  const source = await wallpaperPath(bounds);
  const stat = fs.statSync(source);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = `${source}:${stat.mtimeMs}:${MAX_SIDE}`;
  const out = path.join(CACHE_DIR, 'wallpaper.jpg');
  const keyFile = path.join(CACHE_DIR, 'wallpaper.key');
  if (!fs.existsSync(out) || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '') !== key) {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(MAX_SIDE), source, '--out', out]);
    fs.writeFileSync(keyFile, key);
  }
  return `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
}

module.exports = { wallpaperDataUrl };
