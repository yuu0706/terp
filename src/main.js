const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const config = require('./config');
const { setBlur } = require('./blur');

const ptys = new Map();
let nextId = 1;
let win = null;

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

function createPty(sender, { cols, rows, cwd }) {
  const id = nextId++;
  const shellPath = process.env.SHELL || '/bin/zsh';
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const proc = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd,
    env: shellEnv(),
  });
  ptys.set(id, { proc, cwd: startCwd });
  proc.onData((data) => {
    if (!sender.isDestroyed()) sender.send('pty:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!sender.isDestroyed()) sender.send('pty:exit', id, exitCode);
  });
  return { id, cwd: startCwd };
}

// claude の実行ファイルは版番号（例 2.1.309）の名前で動いている
function programName(name) {
  if (!name) return '';
  const base = path.basename(name);
  return /^\d+\.\d+\.\d+$/.test(base) ? 'claude' : base;
}

// 各シェルの作業場所と、前面で動いているプログラム名を一度の lsof でまとめて拾う
function pollInfo() {
  if (!win || win.isDestroyed() || ptys.size === 0) return;
  const pids = [...ptys.values()].map(({ proc }) => proc.pid).join(',');
  // Finder から起動すると PATH が細いため、絶対パスで呼ぶ
  execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids], (_err, stdout = '') => {
    const cwdByPid = new Map();
    let pid = null;
    for (const line of stdout.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pid) cwdByPid.set(pid, line.slice(1));
    }
    const info = [];
    for (const [id, entry] of ptys) {
      entry.cwd = cwdByPid.get(entry.proc.pid) || entry.cwd;
      let program = '';
      try {
        program = programName(entry.proc.process);
      } catch {
        // 終了直後は名前が取れない
      }
      info.push({ id, cwd: entry.cwd, program });
    }
    if (!win.isDestroyed()) win.webContents.send('pty:info', info);
  });
}

ipcMain.on('home', (event) => {
  event.returnValue = os.homedir();
});
ipcMain.handle('config:get', () => config.loadConfig());
ipcMain.handle('pty:create', (event, opts) => createPty(event.sender, opts));
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.proc.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try {
    ptys.get(id)?.proc.resize(cols, rows);
  } catch {
    // 終了直後の resize は無視する
  }
});
ipcMain.on('pty:kill', (_e, id) => ptys.get(id)?.proc.kill());
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ⌘ の付くキーはメニューで受け、画面へ操作として送る
function buildMenu() {
  const send = (action, arg) => () => win?.webContents.send('menu', action, arg);
  const selectItems = Array.from({ length: 9 }, (_, i) => ({
    label: `ターミナル ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: send('select-index', i),
  }));
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '設定ファイルを開く', accelerator: 'CmdOrCtrl+,', click: () => shell.openPath(config.CONFIG_PATH) },
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
        { label: 'ターミナルを閉じる', accelerator: 'CmdOrCtrl+W', click: send('close') },
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
        { label: '直前のターミナル', accelerator: 'Ctrl+Tab', registerAccelerator: false, click: send('recent') },
        { label: '前のターミナル', accelerator: 'CmdOrCtrl+Shift+[', click: send('prev') },
        { label: '次のターミナル', accelerator: 'CmdOrCtrl+Shift+]', click: send('next') },
        { type: 'separator' },
        ...selectItems,
      ],
    },
    {
      label: '表示',
      submenu: [{ role: 'toggleDevTools', label: '開発者ツール' }, { role: 'togglefullscreen', label: 'フルスクリーン' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const initial = config.loadConfig();
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    // 透過は作成時にしか指定できないため常に有効にし、不透明度は画面側の色で決める
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => setBlur(win, initial.window.blur));
  if (process.env.TERP_SELFTEST) require('./selftest').run(win);
}

app.whenReady().then(() => {
  config.ensureConfigFile();
  buildMenu();
  createWindow();
  // 設定ファイルを保存したら、開いている端末にすぐ反映する
  config.watchConfig((loaded) => {
    if (!win || win.isDestroyed()) return;
    setBlur(win, loaded.window.blur);
    win.webContents.send('config', loaded);
  });
  setInterval(pollInfo, 1500);
});

app.on('window-all-closed', () => {
  for (const { proc } of ptys.values()) proc.kill();
  app.quit();
});
