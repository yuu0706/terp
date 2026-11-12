const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNewRepos } = require('./newrepos');

(async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-newrepos-')));
  try {
    fs.mkdirSync(path.join(dir, 'old', '.git'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const since = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.mkdirSync(path.join(dir, 'fresh', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plain'));
    fs.mkdirSync(path.join(dir, '.hidden', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'deep', 'inner', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'file-git'));
    fs.writeFileSync(path.join(dir, 'file-git', '.git'), 'gitdir: elsewhere');
    const found = await findNewRepos(dir, since);
    assert.deepEqual(found.map((f) => f.path), [path.join(dir, 'fresh')], '後からできた直下のリポジトリだけ');
    assert.ok(found[0].since >= since, 'できた時刻を返す');
    assert.deepEqual(await findNewRepos(path.join(dir, 'missing'), 0), [], '無いフォルダは空');
    console.log('newrepos: ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
