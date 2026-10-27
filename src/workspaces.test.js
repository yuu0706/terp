// Electron を起動せず、旧形式の補完・所属・色と一時フォルダの記録を確かめる。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeProjects, sessionWorkspace, containsPath } = require('./workspaces');
let checked = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checked++; }
function ok(value) { assert.ok(value); checked++; }

async function run() {
  const { contrast, luminance, favoriteText, withAlpha } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, 'renderer/favcolor.js')).toString('base64'));
  for (const input of [undefined, null, {}, { projects: [] }, { workspaces: [] }, { workspaces: [null, {}] }]) {
    equal(normalizeProjects(input).workspaces, [{ id: 'default', name: '既定' }]);
  }
  const legacy = { projects: [{ path: '/repo' }, { path: '/second' }] };
  const migrated = normalizeProjects(legacy);
  equal(migrated.projects.map((p) => p.workspace), ['default', 'default']);
  equal(legacy.projects[0], { path: '/repo' });
  equal(normalizeProjects(migrated), migrated);
  equal(migrated.activeWorkspace, 'default');
  const state = normalizeProjects({ workspaces: [{ id: 'a', name: '仕事' }, { id: 'b', name: '個人' }], activeWorkspace: 'b',
    projects: [{ path: '/repo', workspace: 'a', favorite: true }, { path: '/repo/deep', workspace: 'b' }, { path: '/second', workspace: 'b' }] });
  state.projects[0].worktrees = [{ path: '/outside-work' }];
  equal(state.projects[0].favorite, true);
  equal(state.projects[1].favorite, false);
  equal(normalizeProjects({ ...state, activeWorkspace: 'missing' }).activeWorkspace, 'a');
  equal(normalizeProjects({ ...state, projects: [{ path: '/x', workspace: 'missing' }] }).projects[0].workspace, 'a');
  equal(normalizeProjects({ workspaces: [{ id: 'a', name: ' A ' }, { id: 'a', name: '重複' }] }).workspaces, [{ id: 'a', name: 'A' }]);
  equal(normalizeProjects({ projects: [null, {}, { path: '/x' }, { path: '/x' }] }).projects.length, 1);
  for (const [session, expected] of [
    [{ cwd: '/repo' }, 'a'], [{ cwd: '/repo/src' }, 'a'], [{ cwd: '/repo/deep/src' }, 'b'],
    [{ cwd: '/repo-other' }, 'b'], [{ cwd: '/outside-work/src' }, 'a'], [{ cwd: '/outside-work-other' }, 'b'],
    [{ cwd: '/repo', workspace: 'b' }, 'b'], [{ cwd: '/repo', workspace: 'missing' }, 'a'],
    [{ cwd: '/unknown' }, 'b'], [{}, 'b'], [{ cwd: '/repo', workspace: 'a' }, 'a'],
  ]) equal(sessionWorkspace(session, state), expected);
  equal(containsPath('/repo', '/repository'), false);
  equal(containsPath('/', '/repo'), true);
  equal(containsPath('/repo', undefined), false);
  equal(luminance('#000000'), 0);
  equal(luminance('#ffffff'), 1);
  equal(contrast('#000000', '#ffffff'), 21);
  for (const [accent, text] of [['#89b4fa', '#cdd6f4'], ['#eeeeee', '#dddddd'], ['#ffffff', '#ffffff'],
    ['#b3e5ff', '#cdd6f4'], ['#f9e2af', '#e0e0e0'], ['#ff8800', '#cccccc'], ['#a6e3a1', '#a6adc8']]) {
    const adjusted = favoriteText(accent, text);
    ok(contrast(accent, adjusted) >= 4.5);
    ok(luminance(adjusted) < luminance(text));
    ok([1, 3, 5].every((at) => parseInt(adjusted.slice(at, at + 2), 16) <= parseInt(text.slice(at, at + 2), 16)));
  }
  equal(favoriteText('#000000', '#ffffff'), '#ffffff');
  equal(favoriteText('#ffffff', '#000000'), '#000000');
  equal(favoriteText('#010101', '#020202'), '#000000');
  for (const alpha of [0.2, 0.4, 0.65, 0.9, 1]) {
    equal(Number(withAlpha('#89b4fa', alpha).match(/, ([\d.]+)\)$/)[1]), alpha);
    equal(withAlpha('#89b4fa', alpha), `rgba(137, 180, 250, ${alpha})`);
  }
  const dataURL = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const dropModule = dataURL(fs.readFileSync(path.join(__dirname, 'renderer/droppaths.js'), 'utf8'));
  const paneSource = fs.readFileSync(path.join(__dirname, 'renderer/panes.js'), 'utf8').replace("'./droppaths.js'", JSON.stringify(dropModule));
  const { createPane, splitPane, restoreLayout, paneList } = await import(dataURL(paneSource));
  const firstLayout = splitPane(createPane('t:1'), 'pane-1', 'f:/file', 'right');
  equal(restoreLayout(firstLayout, ['t:1', 'f:/file']), firstLayout);
  equal(paneList(restoreLayout(firstLayout, ['t:1'])).map((p) => p.key), ['t:1']);
  equal(paneList(restoreLayout(firstLayout, ['t:2'])).map((p) => p.key), [null]);
  const transient = splitPane(createPane('t:1'), 'pane-1', 's:/record', 'bottom');
  equal(paneList(restoreLayout(transient, ['t:1', 's:/record'])).map((p) => p.key), ['t:1']);
  equal(restoreLayout(transient, ['t:1', 's:/record'], { transient: true }), transient);
  equal(firstLayout.sizes, [0.5, 0.5]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-workspace-node-'));
  process.env.TERP_CONFIG_DIR = dir;
  try {
    const projects = require('./projects');
    const tabs = require('./tabs');
    const snapshot = require('./snapshot');
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(legacy));
    equal(projects.load(), migrated);
    const b = projects.createWorkspace('個人');
    projects.update('/repo', { favorite: true, workspace: b.id });
    projects.activateWorkspace(b.id);
    projects.reorder(['/second', '/repo']);
    equal(projects.load().projects.map((p) => p.path), ['/second', '/repo']);
    equal(projects.load().projects[1].favorite, true);
    equal(projects.load().projects[1].workspace, b.id);
    assert.throws(() => projects.removeWorkspace(b.id, false)); checked++;
    const empty = projects.createWorkspace('空');
    assert.throws(() => projects.removeWorkspace(empty.id, true)); checked++;
    projects.removeWorkspace(empty.id, false);
    equal(projects.load().workspaces.length, 2);
    projects.renameWorkspace(b.id, '私用');
    equal(projects.load().workspaces[1].name, '私用');
    projects.reorder(['/repo', '/repo', '/unknown']);
    equal(projects.load().projects.map((p) => p.path), ['/second', '/repo']);
    projects.update('/repo', { hidden: true });
    equal(projects.load().projects.map((p) => [p.path, p.hidden]), [['/second', false], ['/repo', true]]);
    projects.update('/repo', { hidden: false });
    const saved = { files: [], order: ['t:1'], active: 't:1', layout: null, workspaces: { [b.id]: { active: 't:1', layout: null } }, fileWorkspaces: {}, sidebarHidden: true, fontDelta: -2 };
    tabs.save(saved);
    equal(tabs.load(), saved);
    const sessions = [{ id: 1, cwd: '/tmp', workspace: b.id, favorite: true }];
    snapshot.save(sessions);
    equal(snapshot.load(), sessions);
    fs.writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify({ files: [], order: ['t:1'], active: 't:1' }));
    equal(tabs.load().workspaces, null);
    fs.writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify({ workspaces: { broken: null, good: { active: 't:1' } } }));
    equal(tabs.load().workspaces, { good: { active: 't:1' } });
    projects.remove('/repo');
    projects.removeWorkspace(b.id, false);
    equal(projects.load().activeWorkspace, 'default');
    assert.throws(() => projects.removeWorkspace('default', false)); checked++;
    assert.throws(() => projects.createWorkspace('  ')); checked++;
    assert.throws(() => projects.update('/second', { workspace: 'missing' })); checked++;
    equal(projects.load().projects[0].path, '/second');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  process.stdout.write(`${checked} 件成功（補完・所属・色・不透明度・枠・記録）\n`);
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
