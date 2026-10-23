// git の操作。worktree の一覧は毎回 git から読み、terp では持たない
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Finder から起動すると PATH が細いため、Homebrew の git も見つかるよう足す
const GIT_ENV = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':'),
  GIT_TERMINAL_PROMPT: '0',
};

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// worktree の中のどこを渡されても、元のリポジトリ（最初の worktree）の場所を返す
async function repoRoot(dir) {
  const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).trim();
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

async function listWorktrees(repo) {
  const out = await git(['worktree', 'list', '--porcelain'], repo);
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: '', head: '', detached: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  list.forEach((w, i) => (w.main = i === 0));
  return list;
}

// 変更のあるファイルの数（追跡外のファイルを含む）
async function changeCount(dir) {
  if (!fs.existsSync(dir)) return 0;
  const out = await git(['status', '--porcelain=v1'], dir);
  return out.split('\n').filter(Boolean).length;
}

// 新しい作業の元にするブランチの既定。origin の既定ブランチ、無ければ元のリポジトリの今のブランチ
async function defaultBase(repo) {
  try {
    return (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).trim();
  } catch {
    return (await git(['branch', '--show-current'], repo)).trim() || 'HEAD';
  }
}

function worktreePath(repo, branch) {
  return path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, branch.replace(/\//g, '-'));
}

async function addWorktree(repo, branch, base) {
  await git(['check-ref-format', '--branch', branch], repo).catch(() => {
    throw new Error(`ブランチ名「${branch}」は git で使えません`);
  });
  const dest = worktreePath(repo, branch);
  if (fs.existsSync(dest)) throw new Error(`作業の置き場所がすでにあります: ${dest}`);
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).then(
    () => true,
    () => false,
  );
  // 既にあるブランチはそのまま使い、無ければ元のブランチから作る
  if (exists) await git(['worktree', 'add', dest, branch], repo);
  else await git(['worktree', 'add', '-b', branch, dest, base], repo);
  return dest;
}

// 変更が残っている worktree は git が拒否する。--force は付けない
async function removeWorktree(repo, dir) {
  await git(['worktree', 'remove', dir], repo);
}

module.exports = { git, repoRoot, listWorktrees, changeCount, defaultBase, addWorktree, removeWorktree };
