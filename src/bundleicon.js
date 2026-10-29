const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
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

module.exports = { bundleIconTarget, bundleIconArgs, setBundleIcon };
