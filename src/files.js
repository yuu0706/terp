// ファイルの一覧と中身の読み出し（閲覧だけ。書き込みは持たない）
const fs = require('fs');
const path = require('path');
const gitpanel = require('./gitpanel');

// 一覧に出さないもの。.git は中身を触られると困るため、DS_Store は見ても意味がないため
const HIDDEN = new Set(['.git', '.DS_Store']);
// これより大きいファイルは中身を読まない（画面が固まるため）
const READ_LIMIT = 2 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 一覧の一番上。git の中なら worktree の一番上、外ならその場所
async function root(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  return (await gitpanel.toplevel(dir)) || dir;
}

async function list(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    let isDir = e.isDirectory();
    // シンボリックリンクは先を見て、フォルダかファイルかを決める。先が無ければファイルとして出す
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    items.push({ name: e.name, path: path.join(dir, e.name), dir: isDir });
  }
  // フォルダを先に、それぞれ名前の順
  return items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ja') : a.dir ? -1 : 1));
}

async function read(file) {
  const stat = await fs.promises.stat(file);
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (stat.size > READ_LIMIT * 5) return { kind: 'too-large', size: stat.size };
    const data = await fs.promises.readFile(file);
    return { kind: 'image', size: stat.size, url: `data:${IMAGE_TYPES[ext]};base64,${data.toString('base64')}` };
  }
  if (stat.size > READ_LIMIT) return { kind: 'too-large', size: stat.size };
  const data = await fs.promises.readFile(file);
  // 先頭 8KB に NUL があればバイナリとみなす（git と同じ見分け方）
  if (data.subarray(0, 8192).includes(0)) return { kind: 'binary', size: stat.size };
  return { kind: 'text', size: stat.size, text: data.toString('utf8') };
}

module.exports = { root, list, read };
