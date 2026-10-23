// git の操作。worktree の一覧は毎回 git から読み、terp では持たない。
// 認証は terp で持たず、ターミナルで git を打ったときと同じもの（SSH の鍵・キーチェーン・gh の認証・
// includeIf による名義の切り替え）をそのまま使う
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Finder から起動すると PATH が細く、SSH エージェントや gh の認証が見つからないことがある。
// ログインシェルが整える環境を一度だけ読み、git に渡す。読めなければ PATH だけ足す
const FALLBACK_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const ENV_MARK = '__TERP_ENV__';
let envPromise = null;

function loginEnv() {
  if (envPromise) return envPromise;
  envPromise = new Promise((resolve) => {
    const base = { ...process.env, PATH: `${process.env.PATH || ''}:${FALLBACK_PATH}` };
    for (const key of Object.keys(base)) if (/^(ELECTRON_|npm_|CLAUDECODE$|CLAUDE_CODE_)/.test(key)) delete base[key];
    const shell = process.env.SHELL || '/bin/zsh';
    let out = '';
    const child = spawn(shell, ['-i', '-l', '-c', `printf '${ENV_MARK}'; env -0`], {
      env: base,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(timer);
      const at = out.indexOf(ENV_MARK);
      if (at < 0) return resolve(base);
      const env = {};
      for (const pair of out.slice(at + ENV_MARK.length).split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      resolve(env.PATH ? env : base);
    });
    child.on('error', () => resolve(base));
  });
  return envPromise;
}

// input を渡すと標準入力に流す。okCodes に入れた終了コードは成功として扱う（diff --no-index の 1 など）
function git(args, cwd, { input, timeout = 30000, okCodes = [0] } = {}) {
  return loginEnv().then(
    (env) =>
      new Promise((resolve, reject) => {
        const child = spawn('git', args, {
          cwd,
          // 認証の入力を求められると止まるため、端末での入力は求めさせない
          env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LANG: env.LANG || 'ja_JP.UTF-8' },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`git ${args[0]} が ${timeout / 1000} 秒で終わりませんでした`));
        }, timeout);
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (okCodes.includes(code)) resolve(stdout);
          else reject(new Error((stderr || stdout || `git ${args[0]} が失敗しました（${code}）`).trim()));
        });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
      }),
  );
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

module.exports = { git, loginEnv, repoRoot, listWorktrees, changeCount, defaultBase, addWorktree, removeWorktree };
