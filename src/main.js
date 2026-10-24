const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const { setBlur } = require('./blur');
const projects = require('./projects');
const gitops = require('./git');
const gitpanel = require('./gitpanel');
const history = require('./history');
const agents = require('./agents');
const agentstatus = require('./agentstatus');
const themegen = require('./themegen');
const subagents = require('./subagents');
const files = require('./files');
const snapshot = require('./snapshot');
const tabs = require('./tabs');
const notify = require('./notify');
const agentreply = require('./agentreply');
const { PtyClient } = require('./ptyclient');

// シェルは常駐のプロセス（ptyhost.js）が持つ。terp を閉じてもシェルは残り、開き直したらつなぎ直す
const client = new PtyClient();
let connecting = null;
// 作業場所と前面のプログラム名の最新の値。控え（snapshot）にも使う
const known = new Map();
let win = null;
let dockAttentionCount = 0;
let lastDockBadge = '';
function updateDockBadge() {
  lastDockBadge = config.loadConfig().dockBadge && dockAttentionCount > 0 ? String(dockAttentionCount) : '';
  app.dock?.setBadge(lastDockBadge);
}

ipcMain.on('dock:badge', (event, count) => {
  if (event.sender !== win?.webContents || !Number.isSafeInteger(count) || count < 0) return;
  dockAttentionCount = count;
  updateDockBadge();
});

exports.__test = { get dockBadge() { return lastDockBadge; } };
notify.init({ getWindow: () => win, toWindow });

// 起動元（npm・Electron・Claude Code）の環境変数をシェルへ持ち込まない
function shellEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_|npm_|CLAUDECODE$|CLAUDE_CODE_|NODE_OPTIONS$)/.test(key)) delete env[key];
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'terp',
    TERM_PROGRAM_VERSION: app.getVersion(),
    LANG: env.LANG && /utf-?8/i.test(env.LANG) ? env.LANG : 'ja_JP.UTF-8',
  };
}

// 窓を閉じた後も、常駐のプロセスからは出力が届き続ける。閉じた窓へ送ると本体でエラーになり、
// その知らせの画面で終了が止まって terp が居残った（2026-10-23 観測）。送る前に必ず窓の有無を確かめる
function toWindow(channel, ...args) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
}

function ensureClient() {
  if (client.socket && !client.socket.destroyed) return Promise.resolve();
  if (!connecting) {
    connecting = client
      .connect()
      .then(({ fresh }) => {
        // 常駐のプロセスが古い版でも、シェルを守るためそのまま使う。画面で知らせる
        if (!fresh) toWindow('host-stale');
      })
      .finally(() => (connecting = null));
  }
  return connecting;
}

client.on('data', (id, data) => toWindow('pty:data', id, data));
// 終わったシェルを控えから消すのは、閉じる操作（pty:kill）と定期の保存に任せる。
// 常駐のプロセスごと止まるとき（Mac の終了など）はシェルが1つずつ終わるため、ここで書くと控えが空になる
client.on('exit', (id, code) => {
  notify.close(id);
  agentreply.forget(id);
  known.delete(id);
  toWindow('pty:exit', id, code);
});
// 常駐のプロセスが落ちたら、そのシェルはすべて終わったものとして扱う
client.on('disconnect', () => {
  for (const id of known.keys()) {
    notify.close(id);
    agentreply.forget(id);
    toWindow('pty:exit', id, null);
  }
  known.clear();
});

async function createPty({ cols, rows, cwd }) {
  await ensureClient();
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const created = await client.request({
    t: 'create',
    cols,
    rows,
    cwd: startCwd,
    env: shellEnv(),
    shell: process.env.SHELL || '/bin/zsh',
  });
  known.set(created.id, { cwd: startCwd, pid: created.pid, program: '' });
  return { id: created.id, cwd: startCwd };
}

// 起動したときに、生きているシェルの一覧と、無ければ前回の控えを返す
async function restoreInfo() {
  await ensureClient();
  const existing = await client.request({ t: 'list' });
  for (const e of existing) known.set(e.id, { cwd: e.cwd, pid: e.pid, program: '' });
  return { existing, snapshot: existing.length === 0 ? snapshot.load() : [] };
}

// 書いている最中に呼ばれたら、その書き込みの終わりを待つ
let saving = null;
function saveSnapshot() {
  if (!saving) saving = writeSnapshot().finally(() => (saving = null));
  return saving;
}

async function writeSnapshot() {
  if (!client.socket || client.socket.destroyed) return;
  try {
    const list = await client.request({ t: 'list' });
    const sessions = await snapshot.claudeSessions(
      list.filter((e) => known.get(e.id)?.program === 'claude').map((e) => e.pid),
    );
    agentreply.rememberSessions(sessions);
    snapshot.save(
      list.map((e) => ({
        cwd: known.get(e.id)?.cwd || e.cwd,
        customName: e.meta.customName || null,
        claudeSession: sessions.get(e.pid) || null,
      })),
    );
  } catch {
    // 控えが書けなくても、動いているシェルには影響しない
  }
}

// claude の実行ファイルは版番号（例 2.1.309）の名前で動いている
function programName(name) {
  if (!name) return '';
  const base = path.basename(name);
  return /^\d+\.\d+\.\d+$/.test(base) ? 'claude' : base;
}

// 各シェルの作業場所と、前面で動いているプログラム名をまとめて拾う
async function pollInfo() {
  if (!win || win.isDestroyed() || known.size === 0 || !client.socket || client.socket.destroyed) return;
  const procs = await client.request({ t: 'info' }).catch(() => []);
  if (procs.length === 0) return;
  // Finder から起動すると PATH が細いため、絶対パスで呼ぶ
  execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', procs.map((p) => p.pid).join(',')], (_err, stdout = '') => {
    const cwdByPid = new Map();
    let pid = null;
    for (const line of stdout.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pid) cwdByPid.set(pid, line.slice(1));
    }
    const info = procs.map((p) => {
      const entry = known.get(p.id) || { cwd: '', pid: p.pid };
      entry.cwd = cwdByPid.get(p.pid) || entry.cwd;
      entry.program = programName(p.program);
      known.set(p.id, entry);
      return { id: p.id, cwd: entry.cwd, program: entry.program };
    });
    toWindow('pty:info', info);
  });
}

ipcMain.on('home', (event) => {
  event.returnValue = os.homedir();
});
ipcMain.on('editor:worker', (event) => {
  try {
    const dir = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs', 'assets');
    const worker = fs.readdirSync(dir).find((name) => name.startsWith('editor.worker-') && name.endsWith('.js'));
    if (!worker) throw new Error('エディタの作業用ファイルが見つかりません');
    event.returnValue = { ok: true, value: pathToFileURL(path.join(dir, worker)).href };
  } catch (err) {
    event.returnValue = { ok: false, error: err.message };
  }
});
ipcMain.handle('config:get', () => config.loadConfig());

// 失敗は例外のまま画面へ渡すと文言が崩れるため、{ error } の形で返す
const safe = (fn) => async (...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle('config:raw', safe(() => config.rawConfig()));
ipcMain.handle('config:update', safe((_e, patch) => config.updateConfig(patch)));
ipcMain.handle('config:themes', safe(() => config.listThemes()));
ipcMain.handle('config:theme-colors', safe((_e, name) => config.getThemeColors(name)));
ipcMain.handle('theme:generate', safe((_e, answers) => themegen.generate(answers)));
ipcMain.handle('theme:save', safe((_e, theme) => themegen.saveTheme(theme)));
ipcMain.handle('config:open-file', safe(() => shell.openPath(config.CONFIG_PATH)));
ipcMain.handle('notify:show', safe(async (_e, message) => {
  const entry = known.get(message?.id);
  if (!entry) return false;
  const settings = config.loadConfig();
  if (!settings.notifications || !(message.kind === 'done' ? settings.notifyAgentDone : message.kind === 'bell' && settings.notifyBell)) return false;
  const request = Symbol();
  entry.notificationRequest = request;
  const reply = message.kind === 'done' && settings.notifyMessage ? await agentreply.find(entry, message.id) : null;
  if (known.get(message.id) !== entry || entry.notificationRequest !== request) return false;
  const current = config.loadConfig();
  if (!current.notifications || !(message.kind === 'done' ? current.notifyAgentDone : current.notifyBell)) return false;
  const useReply = reply && current.notifyMessage;
  const shown = notify.show({ ...message, body: useReply ? reply.body : message.body });
  if (shown && useReply) agentreply.remember(message.id, reply);
  return shown;
}));
ipcMain.handle('notify:test', safe(() => notify.show({ title: 'terp', body: '通知の試し' })));
ipcMain.handle('tabs:load', safe(() => tabs.load()));
ipcMain.handle('tabs:save', safe((_e, state) => tabs.save(state)));
ipcMain.handle('projects:list', safe(() => projects.list()));
// dir を渡さないときはフォルダを選ぶ画面を出す
ipcMain.handle(
  'projects:add',
  safe(async (event, dir) => {
    if (!dir) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'リポジトリを追加',
        buttonLabel: '追加',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      dir = result.filePaths[0];
    }
    return projects.add(dir);
  }),
);
ipcMain.handle('projects:remove', safe((_e, repo) => projects.remove(repo)));
ipcMain.handle('projects:reorder', safe((_e, order) => projects.reorder(order)));
ipcMain.handle('work:create', safe((_e, { repo, branch, base }) => gitops.addWorktree(repo, branch, base)));
ipcMain.handle('work:remove', safe((_e, { repo, dir }) => gitops.removeWorktree(repo, dir)));
ipcMain.handle('work:changes', safe((_e, dir) => gitops.changeCount(dir)));
ipcMain.handle('files:root', safe((_e, dir) => files.root(dir)));
ipcMain.handle('files:list', safe((_e, dir) => files.list(dir)));
ipcMain.handle('files:read', safe((_e, file) => files.read(file)));
ipcMain.handle('files:stat', safe((_e, file) => files.stat(file)));
ipcMain.handle('files:write', safe((_e, { file, text, mtime, force }) => files.write(file, text, mtime, force)));
// 既定のアプリで開く・Finder で見せる
ipcMain.handle('files:open-external', safe((_e, file) => shell.openPath(file)));
ipcMain.handle('files:reveal', safe((_e, file) => shell.showItemInFolder(file)));
ipcMain.handle('agents:list', safe(() => agents.detect(config.loadConfig().agents)));
ipcMain.handle('agents:status', safe(() => agentstatus.check(config.loadConfig().agents)));
ipcMain.handle('subagents:list', safe(async () => {
  const entries = [...known.values()];
  const byPid = await subagents.list(
    entries.map((entry) => entry.pid),
    entries.filter((entry) => entry.program === 'claude').map((entry) => entry.pid),
  );
  return Object.fromEntries([...known].map(([id, entry]) => [id, byPid.get(entry.pid) || []]));
}));
ipcMain.handle('subagents:read', safe((_e, file, offset) => subagents.read(file, offset)));
ipcMain.handle('history:log', safe((_e, { dir, ...options }) => history.log(dir, options)));
ipcMain.handle('history:commit', safe((_e, { dir, hash }) => history.commit(dir, hash)));
ipcMain.handle('history:diff', safe((_e, { dir, hash, file }) => history.commitDiff(dir, hash, file)));
ipcMain.handle('git:status', safe((_e, dir) => gitpanel.status(dir)));
ipcMain.handle('git:diff', safe((_e, { top, file, kind }) => gitpanel.diff(top, file, kind)));
ipcMain.handle('git:stage', safe((_e, { top, files }) => gitpanel.stage(top, files)));
ipcMain.handle('git:unstage', safe((_e, { top, files }) => gitpanel.unstage(top, files)));
ipcMain.handle('git:commit', safe((_e, { top, message }) => gitpanel.commit(top, message)));
ipcMain.handle('git:push', safe((_e, top) => gitpanel.push(top)));
ipcMain.handle('git:pull', safe((_e, top) => gitpanel.pull(top)));
ipcMain.handle('git:fetch', safe((_e, top) => gitpanel.fetch(top)));
ipcMain.handle('pty:create', (_e, opts) => createPty(opts));
ipcMain.handle('pty:restore-info', () => restoreInfo());
ipcMain.handle('pty:attach', async (_e, id) => {
  await ensureClient();
  return client.request({ t: 'attach', id });
});
ipcMain.on('pty:write', (_e, id, data) => client.send({ t: 'write', id, data }));
ipcMain.on('pty:resize', (_e, id, cols, rows) => client.send({ t: 'resize', id, cols, rows }));
ipcMain.on('pty:kill', (_e, id) => {
  notify.close(id);
  agentreply.forget(id);
  const entry = known.get(id);
  if (entry) entry.notificationRequest = null;
  client.send({ t: 'kill', id });
  // 閉じたターミナルを控えから消す。シェルが終わるのを少し待つ
  setTimeout(saveSnapshot, 500);
});
// 名前などは常駐のプロセスに預け、開き直したときに戻す
ipcMain.on('pty:meta', (_e, id, meta) => {
  client.send({ t: 'meta', id, meta });
  if ('customName' in meta) saveSnapshot();
});
// 自己診断で、Mac の再起動に当たる状態（常駐のプロセスごと消える）を作る
ipcMain.handle('pty:shutdown-host', async () => {
  await saveSnapshot();
  return client.request({ t: 'shutdown' });
});
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ⌘ の付くキーはメニューで受け、画面へ操作として送る
function buildMenu() {
  const send = (action, arg) => () => toWindow('menu', action, arg);
  const selectItems = Array.from({ length: 9 }, (_, i) => ({
    label: `タブ ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: send('select-index', i),
  }));
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '設定…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { label: '設定ファイルを開く', click: () => shell.openPath(config.CONFIG_PATH) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'ターミナル',
      submenu: [
        { label: '新しいターミナル', accelerator: 'CmdOrCtrl+T', click: send('new') },
        { label: '右に分割', accelerator: 'CmdOrCtrl+\\', click: send('split-right') },
        { label: '新しい作業…', accelerator: 'CmdOrCtrl+N', click: send('new-work') },
        { label: 'リポジトリを追加…', click: send('add-project') },
        { label: 'タブを閉じる', accelerator: 'CmdOrCtrl+W', click: send('close') },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { type: 'separator' },
        { label: '画面を消去', accelerator: 'CmdOrCtrl+K', click: send('clear') },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { label: 'すべて選択', accelerator: 'CmdOrCtrl+A', click: send('select-all') },
      ],
    },
    {
      label: '移動',
      submenu: [
        // ⌃Tab は端末が先に受け取るため、画面側で処理し、メニューには表示だけする
        { label: '直前のタブ', accelerator: 'Ctrl+Tab', registerAccelerator: false, click: send('recent') },
        { label: '前のタブ', accelerator: 'CmdOrCtrl+Shift+[', click: send('prev') },
        { label: '次のタブ', accelerator: 'CmdOrCtrl+Shift+]', click: send('next') },
        { label: '次の要対応', accelerator: 'CmdOrCtrl+Shift+J', click: send('next-attention') },
        { type: 'separator' },
        { label: '左の枠', accelerator: 'CmdOrCtrl+Alt+Left', click: send('pane-left') },
        { label: '右の枠', accelerator: 'CmdOrCtrl+Alt+Right', click: send('pane-right') },
        { label: '上の枠', accelerator: 'CmdOrCtrl+Alt+Up', click: send('pane-up') },
        { label: '下の枠', accelerator: 'CmdOrCtrl+Alt+Down', click: send('pane-down') },
        { type: 'separator' },
        ...selectItems,
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: 'ファイル', accelerator: 'CmdOrCtrl+Shift+E', click: send('toggle-files') },
        { label: '変更の一覧', accelerator: 'CmdOrCtrl+Shift+G', click: send('toggle-git') },
        { label: '履歴', accelerator: 'CmdOrCtrl+Shift+H', click: send('toggle-history') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let quitRequested = false;
let allowClose = false;
let closeRequest = null;
let closeSerial = 0;

function finishClose(allow) {
  if (!closeRequest) return;
  clearTimeout(closeRequest.timer);
  closeRequest = null;
  if (!allow) {
    quitRequested = false;
    return;
  }
  allowClose = true;
  if (quitRequested) app.quit();
  else win?.close();
}

ipcMain.on('window:close-reply', (event, id, answer) => {
  if (!closeRequest || closeRequest.id !== id || event.sender !== win?.webContents) return;
  // 画面が応答した後は、利用者が確認画面で選ぶまで待つ
  if (answer === 'pending') clearTimeout(closeRequest.timer);
  else if (typeof answer === 'boolean') finishClose(answer);
});

function createWindow() {
  const initial = config.loadConfig();
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    // 透過は作成時にしか指定できないため常に有効にし、不透明度は画面側の色で決める
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    // 自己診断の窓は手前に出さない。利用者が別の窓で打っている文字を奪わないため
    show: !process.env.TERP_SELFTEST,
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closeRequest) return;
    const id = ++closeSerial;
    closeRequest = { id, timer: setTimeout(() => finishClose(true), 2000) };
    toWindow('window:close-request', id);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    setBlur(win, initial.window.blur);
    if (process.env.TERP_SELFTEST) win.showInactive();
  });
  if (process.env.TERP_SELFTEST) require('./selftest').run(win);
}

app.whenReady().then(() => {
  config.ensureConfigFile();
  buildMenu();
  createWindow();
  // 設定ファイルを保存したら、開いている端末にすぐ反映する
  config.watchConfig((loaded) => {
    updateDockBadge();
    if (!win || win.isDestroyed()) return;
    setBlur(win, loaded.window.blur);
    toWindow('config', loaded);
  });
  setInterval(pollInfo, 1500);
  setInterval(saveSnapshot, 10000);
});

// シェルは常駐のプロセスに残すため、ここでは止めない
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitRequested = true;
  saveSnapshot();
});
// 終わるときは常駐のプロセスとの接続を切り、出力が届かないようにする。シェルは常駐のプロセスに残る
app.on('will-quit', () => client.socket?.destroy());
