// 一覧に出すリポジトリの記録（~/.config/terp/projects.json）。worktree そのものは git から読む
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');
const gitops = require('./git');

const PROJECTS_PATH = path.join(CONFIG_DIR, 'projects.json');

function readPaths() {
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'));
    return Array.isArray(data.projects) ? data.projects.map((p) => p.path).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writePaths(paths) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify({ projects: paths.map((p) => ({ path: p })) }, null, 2) + '\n');
}

async function add(dir) {
  const repo = await gitops.repoRoot(dir).catch(() => {
    throw new Error(`git のリポジトリではありません: ${dir}`);
  });
  const paths = readPaths();
  if (!paths.includes(repo)) writePaths([...paths, repo]);
  return repo;
}

// 一覧の並びを変える。知らないパスは無視し、渡されなかったものは後ろに残す
function reorder(order) {
  const paths = readPaths();
  const next = order.filter((p) => paths.includes(p));
  writePaths([...next, ...paths.filter((p) => !next.includes(p))]);
}

function remove(repo) {
  writePaths(readPaths().filter((p) => p !== repo));
}

// 画面に渡す形。リポジトリが消えていたら error を付けて返す
async function list() {
  return Promise.all(
    readPaths().map(async (repo) => {
      const project = { path: repo, name: path.basename(repo), base: '', worktrees: [], error: null };
      try {
        project.base = await gitops.defaultBase(repo);
        const worktrees = await gitops.listWorktrees(repo);
        project.worktrees = await Promise.all(
          worktrees.map(async (w) => ({ ...w, changes: await gitops.changeCount(w.path).catch(() => 0) })),
        );
      } catch (err) {
        project.error = err.message;
      }
      return project;
    }),
  );
}

module.exports = { add, remove, reorder, list };
