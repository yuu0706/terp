// ファイルの一覧・読み出し・保存
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
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
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('通常のファイルではありません');
    const meta = { size: stat.size, mtime: stat.mtimeMs };
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (stat.size > READ_LIMIT * 5) return { kind: 'too-large', ...meta };
      const data = await handle.readFile();
      return { kind: 'image', ...meta, url: `data:${IMAGE_TYPES[ext]};base64,${data.toString('base64')}` };
    }
    if (stat.size > READ_LIMIT) return { kind: 'too-large', ...meta };
    const data = await handle.readFile();
    // 先頭 8KB に NUL があればバイナリとみなす（git と同じ見分け方）
    if (data.subarray(0, 8192).includes(0)) return { kind: 'binary', ...meta };
    return { kind: 'text', ...meta, text: data.toString('utf8') };
  } finally {
    await handle.close();
  }
}

async function stat(file) {
  try {
    const s = await fs.promises.stat(file);
    return { exists: true, mtime: s.mtimeMs, size: s.size, mode: s.mode, file: s.isFile() };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, mtime: null };
    throw err;
  }
}

// 同じファイルへの保存を重ねても、先の保存を後の保存が追い越さないようにする
const writes = new Map();
async function write(file, text, expectedMtime, force = false) {
  if (typeof file !== 'string' || typeof text !== 'string' || typeof force !== 'boolean') throw new Error('保存の指定を確認してください');
  if (!force && !Number.isFinite(expectedMtime)) throw new Error('更新時刻を確認できません');
  // リンク自体を置き換えるとリンク先との関係が切れるため、実体を保存する
  const target = await fs.promises.realpath(file).catch((err) => {
    if (err.code === 'ENOENT') return path.resolve(file);
    throw err;
  });
  const previous = writes.get(target) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const before = await stat(target);
    if (!force && before.mtime !== expectedMtime) return { conflict: true, mtime: before.mtime };
    if (before.exists && !before.file) throw new Error('通常のファイルではありません');
    const tmp = path.join(path.dirname(target), `.terp-${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: before.exists ? before.mode & 0o777 : 0o666 });
      if (before.exists) await fs.promises.chmod(tmp, before.mode & 0o777);
      const saved = await stat(tmp);
      const latest = await stat(target);
      if (!force && latest.mtime !== expectedMtime) return { conflict: true, mtime: latest.mtime };
      await fs.promises.rename(tmp, target);
      return { conflict: false, mtime: saved.mtime, size: saved.size };
    } finally {
      await fs.promises.unlink(tmp).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    }
  });
  writes.set(target, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(target) === pending) writes.delete(target);
  }
}

module.exports = { root, list, read, write, stat };
