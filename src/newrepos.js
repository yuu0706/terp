// 端末の作業場所の直下で、git の管理が始まったフォルダを探す。
// ルートで claude を立ち上げて新しいプロジェクトを作ったとき、その端末をリポジトリへまとめる案内に使う
const fs = require('fs');
const path = require('path');

// ホームのように項目の多いフォルダでも、数秒ごとに見て重くならないよう上限を設ける
const MAX_ENTRIES = 500;

// since（ミリ秒）以降に .git ができた直下のフォルダを、できた時刻と一緒に返す
async function findNewRepos(dir, since) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const repo = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(path.join(repo, '.git'));
      if (!stat.isDirectory() || stat.birthtimeMs < since) continue;
      found.push({ path: await fs.promises.realpath(repo), since: stat.birthtimeMs });
    } catch {
      // .git が無いフォルダ
    }
  }
  return found;
}

module.exports = { findNewRepos, MAX_ENTRIES };
