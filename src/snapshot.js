// 常駐のプロセスごと消えたとき（Mac の再起動など）に開き直すための控え（~/.config/terp/sessions.json）。
// 作業場所・名前・claude の会話の ID だけを残す。画面の中身は残らない
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

// シェルの pid ごとに、その下で動いている claude の会話の ID を返す。
// claude agents --json が会話の pid と ID を出すため、pid の親をたどってシェルに行き着くものを結ぶ
async function claudeSessions(shellPids) {
  const result = new Map();
  const claude = CLAUDE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!claude || shellPids.length === 0) return result;
  const [agentsOut, psOut] = await Promise.all([run(claude, ['agents', '--json']), run('/bin/ps', ['-A', '-o', 'pid=,ppid='])]);
  let agents = [];
  try {
    agents = JSON.parse(agentsOut);
  } catch {
    return result;
  }
  const parent = new Map();
  for (const line of psOut.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parent.set(pid, ppid);
  }
  const shells = new Set(shellPids);
  for (const a of agents) {
    if (a.kind !== 'interactive' || !a.pid || !a.sessionId) continue;
    let pid = a.pid;
    for (let depth = 0; depth < 10 && pid > 1; depth++) {
      if (shells.has(pid)) {
        result.set(pid, a.sessionId);
        break;
      }
      pid = parent.get(pid);
    }
  }
  return result;
}

module.exports = { load, save, claudeSessions };
