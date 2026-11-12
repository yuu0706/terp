// 常駐のプロセスごと消えたとき（Mac の再起動など）に開き直すための控え（~/.config/terp/sessions.json）。
// 作業場所・名前・所属・ドラフトから外したか・claude の会話の ID を残す。画面の中身は残らない
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { CONFIG_DIR } = require('./config');

const SNAPSHOT_PATH = path.join(CONFIG_DIR, 'sessions.json');
const CLAUDE_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

function save(sessions) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = JSON.stringify({ savedAt: new Date().toISOString(), sessions }, null, 2) + '\n';
  // 書きかけのファイルを読まれないよう、別名で書いてから置き換える
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, SNAPSHOT_PATH);
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// シェルの pid ごとに、その下で動いている claude の会話の ID と設定のフォルダを返す（{ sessionId, configDir }）。
// claude agents --json が会話の pid と ID を出すため、pid の親をたどってシェルに行き着くものを結ぶ。
// claude agents は既定の設定のフォルダ（~/.claude）の会話しか出さない。CLAUDE_CONFIG_DIR で別のフォルダを使う claude は、
// そのフォルダの sessions/<pid>.json から拾い、再開するときも同じフォルダを渡す（2026-10-29 利用者の指摘）
async function claudeSessionDetails(shellPids) {
  const result = new Map();
  const claude = CLAUDE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!claude || shellPids.length === 0) return result;
  const [agentsOut, psOut] = await Promise.all([run(claude, ['agents', '--json']), run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='])]);
  let agents = [];
  try {
    agents = JSON.parse(agentsOut);
  } catch {
    agents = [];
  }
  const parent = new Map();
  const names = new Map();
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    parent.set(Number(m[1]), Number(m[2]));
    names.set(Number(m[1]), path.basename(m[3]));
  }
  const shells = new Set(shellPids);
  const shellOf = (pid) => {
    for (let depth = 0; depth < 10 && pid > 1; depth++) {
      if (shells.has(pid)) return pid;
      pid = parent.get(pid);
    }
    return null;
  };
  for (const a of agents) {
    if (a.kind !== 'interactive' || !a.pid || !a.sessionId) continue;
    const shell = shellOf(a.pid);
    if (shell) result.set(shell, { sessionId: a.sessionId, configDir: null });
  }
  // 見つからなかったシェルの下の claude（実行ファイルは版番号の名前で動く）を、設定のフォルダの控えから拾う
  for (const [pid, name] of names) {
    if (name !== 'claude' && !/^\d+\.\d+\.\d+$/.test(name)) continue;
    const shell = shellOf(parent.get(pid));
    if (!shell || result.has(shell)) continue;
    const configDir = await processConfigDir(pid);
    if (!configDir) continue;
    const sessionId = await sessionOfPid(configDir, pid);
    if (sessionId) result.set(shell, { sessionId, configDir });
  }
  return result;
}

// シェルの pid ごとの会話の ID だけを返す
async function claudeSessions(shellPids) {
  return new Map([...(await claudeSessionDetails(shellPids))].map(([pid, found]) => [pid, found.sessionId]));
}

// プロセスの環境変数の CLAUDE_CONFIG_DIR。ps の出力では環境変数が空白で区切られるため、空白を含む値は拾えない
async function processConfigDir(pid) {
  const out = await run('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)]);
  const m = out.match(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/);
  if (!m || !path.isAbsolute(m[1])) return null;
  return path.resolve(m[1]);
}

// 設定のフォルダの sessions/<pid>.json から会話の ID を読む。pid は使い回されるため、控えの起動時刻とプロセスの起動時刻を比べる
async function sessionOfPid(configDir, pid) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (data.pid !== pid || data.kind !== 'interactive' || typeof data.sessionId !== 'string') return null;
  const started = await processStart(pid);
  // 控えの起動時刻は UTC で書かれる（claude 2.1.312 で確認）。版による違いに備え、地域の時刻としても比べる
  const near = (text) => Math.abs(Date.parse(text) - started) <= 2000;
  if (!started || typeof data.procStart !== 'string' || !(near(`${data.procStart} UTC`) || near(data.procStart))) return null;
  return data.sessionId;
}

// プロセスの起動時刻（ミリ秒）。曜日と月の名前を英語で受けるため、言語の設定を C にする
function processStart(pid) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      const time = err ? NaN : Date.parse(stdout.trim().replace(/\s+/g, ' '));
      resolve(Number.isFinite(time) ? time : null);
    });
  });
}

module.exports = { load, save, claudeSessions, claudeSessionDetails, processStart };
