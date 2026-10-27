// 古い記録の補完と端末の所属は、ファイルや常駐プロセスに触れずに決める。
const DEFAULT_WORKSPACE = 'default';

function normalizeProjects(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const seen = new Set();
  const workspaces = (Array.isArray(value.workspaces) ? value.workspaces : []).filter((w) => {
    if (!w || typeof w.id !== 'string' || !w.id || typeof w.name !== 'string' || !w.name.trim() || seen.has(w.id)) return false;
    seen.add(w.id);
    return true;
  }).map((w) => ({ id: w.id, name: w.name.trim() }));
  if (!workspaces.length) workspaces.push({ id: DEFAULT_WORKSPACE, name: '既定' });
  const fallback = workspaces[0].id;
  const valid = (id) => workspaces.some((w) => w.id === id);
  const paths = new Set();
  const list = (Array.isArray(value.projects) ? value.projects : []).filter((p) => {
    if (!p || typeof p.path !== 'string' || !p.path || paths.has(p.path)) return false;
    paths.add(p.path);
    return true;
  });
  // draft は左の一覧の「ドラフト」に出すか（2026-10-27 お気に入りと「隠す」を置き換えた）。
  // 旧形式は、お気に入りが1つでもあればお気に入りを、無ければ隠していないものをドラフトとして読む
  const anyFavorite = list.some((p) => p.favorite === true);
  const projects = list.map(({ favorite, hidden, ...p }) => ({ ...p, workspace: valid(p.workspace) ? p.workspace : fallback,
    draft: typeof p.draft === 'boolean' ? p.draft : anyFavorite ? favorite === true : hidden !== true }));
  return { ...value, projects, workspaces, activeWorkspace: valid(value.activeWorkspace) ? value.activeWorkspace : fallback };
}

function containsPath(root, cwd) {
  return typeof root === 'string' && typeof cwd === 'string' && (cwd === root || cwd.startsWith(root.replace(/\/$/, '') + '/'));
}

function sessionWorkspace(session, state) {
  if (state.workspaces.some((w) => w.id === session.workspace)) return session.workspace;
  const candidates = state.projects.flatMap((p) => [p.path, ...(p.worktrees || []).map((w) => w.path)]
    .filter((root) => containsPath(root, session.cwd)).map((root) => ({ root, workspace: p.workspace })));
  candidates.sort((a, b) => b.root.length - a.root.length);
  return candidates[0]?.workspace || state.activeWorkspace;
}

module.exports = { DEFAULT_WORKSPACE, normalizeProjects, containsPath, sessionWorkspace };
