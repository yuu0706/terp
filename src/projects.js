// 一覧に出すリポジトリとワークスペースの記録。worktree そのものは git から読む
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { CONFIG_DIR } = require('./config');
const gitops = require('./git');
const { normalizeProjects } = require('./workspaces');

const PROJECTS_PATH = path.join(CONFIG_DIR, 'projects.json');

function load() {
  try {
    return normalizeProjects(JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')));
  } catch {
    return normalizeProjects();
  }
}

function save(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${PROJECTS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, PROJECTS_PATH);
}

function requireWorkspace(data, id) {
  const workspace = data.workspaces.find((w) => w.id === id);
  if (!workspace) throw new Error('ワークスペースが見つからない。一覧を開き直す');
  return workspace;
}

async function add(dir, workspace) {
  const repo = await gitops.repoRoot(dir).catch(() => {
    throw new Error(`git のリポジトリではありません: ${dir}`);
  });
  const data = load();
  workspace ||= data.activeWorkspace;
  requireWorkspace(data, workspace);
  const existing = data.projects.find((p) => p.path === repo);
  if (!existing) {
    data.projects.push({ path: repo, workspace, draft: true });
    save(data);
  } else if (existing.workspace !== workspace) {
    existing.workspace = workspace;
    save(data);
  }
  return repo;
}

// 渡されなかったリポジトリの位置は保ち、表示中の部分だけ並べ替える。
function reorder(order) {
  const data = load();
  const next = [...new Set(order)].map((p) => data.projects.find((entry) => entry.path === p)).filter(Boolean);
  const paths = new Set(next.map((p) => p.path));
  data.projects = data.projects.map((p) => paths.has(p.path) ? next.shift() : p);
  save(data);
}

function remove(repo) {
  const data = load();
  data.projects = data.projects.filter((p) => p.path !== repo);
  save(data);
}

function update(repo, patch) {
  const data = load();
  const project = data.projects.find((p) => p.path === repo);
  if (!project) throw new Error('リポジトリが見つからない。一覧を開き直す');
  if ('workspace' in patch) {
    requireWorkspace(data, patch.workspace);
    project.workspace = patch.workspace;
  }
  if ('draft' in patch) project.draft = Boolean(patch.draft);
  save(data);
}

function createWorkspace(name) {
  const data = load();
  name = String(name || '').trim();
  if (!name) throw new Error('名前を入力');
  const workspace = { id: randomUUID(), name };
  data.workspaces.push(workspace);
  save(data);
  return workspace;
}

function renameWorkspace(id, name) {
  const data = load();
  const workspace = requireWorkspace(data, id);
  name = String(name || '').trim();
  if (!name) throw new Error('名前を入力');
  workspace.name = name;
  save(data);
}

function activateWorkspace(id) {
  const data = load();
  requireWorkspace(data, id);
  data.activeWorkspace = id;
  save(data);
}

function removeWorkspace(id, occupied) {
  const data = load();
  requireWorkspace(data, id);
  if (data.workspaces.length === 1) throw new Error('最後のワークスペースは削除できない');
  if (occupied || data.projects.some((p) => p.workspace === id)) throw new Error('リポジトリかターミナルがあるため削除できない');
  data.workspaces = data.workspaces.filter((w) => w.id !== id);
  if (data.activeWorkspace === id) data.activeWorkspace = data.workspaces[0].id;
  save(data);
}

// リポジトリが消えていたら error を付けて返す。
async function list() {
  return Promise.all(load().projects.map(async (entry) => {
    const repo = entry.path;
    const project = { ...entry, name: path.basename(repo), base: '', worktrees: [], error: null };
    try {
      project.base = await gitops.defaultBase(repo);
      const worktrees = await gitops.listWorktrees(repo);
      project.worktrees = await Promise.all(worktrees.map(async (w) => ({ ...w, changes: await gitops.changeCount(w.path).catch(() => 0) })));
    } catch (err) {
      project.error = err.message;
    }
    return project;
  }));
}

module.exports = { add, remove, reorder, update, list, load, createWorkspace, renameWorkspace, activateWorkspace, removeWorkspace };
