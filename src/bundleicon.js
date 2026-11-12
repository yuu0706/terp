const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const runFile = promisify(execFile);
const SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const image = argv[1] ? $.NSImage.alloc.initWithContentsOfFile(argv[1]) : $();
  if (argv[1] && image.isNil()) return 'false';
  return String(Boolean($.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0)));
}`;

function bundleIconTarget({ isPackaged, execPath = process.execPath, env = process.env }) {
  if (env.TERP_BUNDLE_ICON_TARGET) return path.resolve(env.TERP_BUNDLE_ICON_TARGET);
  if (!isPackaged) return null;
  const target = path.dirname(path.dirname(path.dirname(execPath)));
  return target.endsWith('.app') ? target : null;
}

function bundleIconArgs(target, pngPath) {
  return ['-l', 'JavaScript', '-e', SCRIPT, target, pngPath || ''];
}

async function setBundleIcon(target, png, remove, execute = runFile) {
  let dir;
  try {
    let pngPath = '';
    if (!remove) {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terp-bundle-icon-'));
      pngPath = path.join(dir, 'icon.png');
      await fs.writeFile(pngPath, png);
    }
    const { stdout } = await execute('/usr/bin/osascript', bundleIconArgs(target, pngPath), { timeout: 10000, encoding: 'utf8' });
    if (stdout.trim() !== 'true') throw new Error('アプリのアイコンを変更できなかった');
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

// 最後に貼った絵（色と外したか）をアプリの外に控え、同じ絵が貼れたままなら起動のたびに貼り直さない。
// 貼り直すと Dock の作り直しが要るため（dockicon.js の bundleChanged）。貼れているかは、アプリのフォルダの直下の Icon\r で見る。
// npm run install-app で入れ直すと Icon\r が消えるため、そのときは控えが合っていても貼り直す
function createAppliedStore(file) {
  const read = () => {
    try {
      return JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    applied(target, key, remove) {
      const saved = read();
      if (!saved || saved.target !== target || saved.key !== key) return false;
      return fsSync.existsSync(path.join(target, 'Icon\r')) === !remove;
    },
    save(target, key) {
      try {
        fsSync.writeFileSync(file, JSON.stringify({ target, key }) + '\n');
      } catch {
        // 控えが書けなければ、次の起動で貼り直すだけ
      }
    },
  };
}

// Dock は閉じているアプリの絵を覚えていて、アプリのフォルダの絵を変えても古い絵のまま出す（2026-10-29 利用者の画面で確認。
// killall Dock で作り直すと新しい絵になった）。terp が終わるのを待ってから Dock を作り直す。最大10秒待つ
function dockRefreshArgs(pid) {
  return ['-c', `for i in $(seq 50); do kill -0 ${Number(pid)} 2>/dev/null || break; sleep 0.2; done; /usr/bin/killall Dock`];
}

function refreshDockAfterExit(pid = process.pid, run = spawn) {
  const child = run('/bin/sh', dockRefreshArgs(pid), { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { bundleIconTarget, bundleIconArgs, setBundleIcon, createAppliedStore, dockRefreshArgs, refreshDockAfterExit };
