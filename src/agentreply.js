const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { createHash } = require('crypto');

const TAIL_BYTES = 256 * 1024;
const MAX_BYTES = 1024 * 1024;
const WAIT_MS = 2000;
const SESSIONS_TTL = 15000;
const sessions = new Map();
const used = new Map();
let testLookup = null;

function formatReply(value) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/```[\s\S]*?(?:```|$)/g, '（コード）')
    .replace(/!?\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+|\s+#+\s*$/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}[^\n]*\|[^\n]*$/gm, '')
    .replace(/^.*\|.*$/gm, (line) => line.replace(/\|/g, ' '))
    .replace(/\*\*|__|`/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => /\s/.test(char) ? ' ' : '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.slice(0, 300).join('') + (chars.length > 300 ? '…' : '');
}

function userTurn(row) {
  if (row.isSidechain || row.type !== 'user') return false;
  const content = row.message?.content;
  return typeof content === 'string' || (Array.isArray(content) && content.some((block) => block?.type !== 'tool_result'));
}

function extract(rows, kind) {
  if (kind === 'codex') {
    const row = rows.findLast((r) => r.type === 'event_msg' && r.payload?.type === 'task_complete');
    return { text: typeof row?.payload.last_agent_message === 'string' ? row.payload.last_agent_message : '', found: Boolean(row) };
  }
  // 通知に出すのは締めの返答だけにする。道具を使った応答では、最後の道具の結果より後の文が締めになる。
  // 途中の「調べます」などの文は入れない。利用者の発言の後に道具を使っていなければ、発言の後の文を使う
  const texts = (from) => {
    const parts = [];
    for (const row of rows.slice(from + 1)) {
      if (row.isSidechain || row.type !== 'assistant') continue;
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts;
  };
  const lastUser = rows.findLastIndex((row) => !row.isSidechain && row.type === 'user');
  if (lastUser < 0) return { text: '', found: false };
  if (userTurn(rows[lastUser])) return { text: texts(lastUser).join('\n'), found: true };
  const closing = texts(lastUser);
  if (closing.length) return { text: closing.join('\n'), found: true };
  // 道具の結果の後にまだ文が無いときは、書き終わっていないものとして次の読み直しに任せる
  return { text: '', found: true };
}

async function readReply(file, kind) {
  let fd;
  try {
    if (process.env.TERP_SELFTEST && (!process.env.TERP_REPLY_FAKE_DIR || !await within(file, process.env.TERP_REPLY_FAKE_DIR))) return '';
    fd = await fs.promises.open(file, 'r');
    const stat = await fd.stat();
    if (!stat.isFile()) return '';
    for (const limit of [TAIL_BYTES, MAX_BYTES]) {
      const start = Math.max(0, stat.size - limit);
      const buffer = Buffer.alloc(Math.min(stat.size, limit) + (start > 0 ? 1 : 0));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, start > 0 ? start - 1 : 0);
      const text = buffer.subarray(start > 0 ? 1 : 0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      if (start > 0 && buffer[0] !== 10) lines.shift();
      const rows = [];
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object') rows.push(row);
        } catch { /* 書きかけと壊れた行は次の読み直しに任せる */ }
      }
      const reply = extract(rows, kind);
      if (reply.found || start === 0) return reply.text;
    }
  } catch { /* 読めなくても通知の本文は従来のものを使う */ }
  finally { await fd?.close().catch(() => {}); }
  return '';
}

async function within(file, root) {
  try {
    const [real, base] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)]);
    const relative = path.relative(base, real);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? real : null;
  } catch { return null; }
}

function projectRoots() {
  if (process.env.TERP_SELFTEST) {
    return process.env.TERP_REPLY_FAKE_DIR ? [path.join(process.env.TERP_REPLY_FAKE_DIR, 'projects')] : [];
  }
  return ['.claude', '.claude2'].map((dir) => path.join(os.homedir(), dir, 'projects'));
}

async function claudeFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return null;
  for (const root of projectRoots()) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = await within(path.join(root, entry.name, `${sessionId}.jsonl`), root);
      if (file) return file;
    }
  }
  return null;
}

function run(file, args, signal) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: WAIT_MS, maxBuffer: 8 * MAX_BYTES, signal }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// snapshot の既存の探索は10秒待つため、変更せず別プロセスごと2秒以内で打ち切る。
// 子の ps と Claude CLI も同じプロセス群に置き、通知を出した後に探索を残さない
function lookupSessions(pids, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(new Map());
    const child = spawn(process.execPath, [__filename, '--claude-sessions', ...pids.map(String)], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '';
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(value);
    };
    const stop = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      finish(new Map());
    };
    const timer = setTimeout(stop, WAIT_MS);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > MAX_BYTES) stop();
    });
    child.on('error', () => finish(new Map()));
    child.on('close', () => {
      try { finish(new Map(JSON.parse(output))); } catch { finish(new Map()); }
    });
  });
}

function rememberSessions(map) {
  const now = Date.now();
  for (const [pid, entry] of sessions) if (now - entry.at >= SESSIONS_TTL) sessions.delete(pid);
  for (const [pid, sessionId] of map) sessions.set(pid, { at: now, sessionId });
}

async function codexFile(shellPid, signal) {
  const output = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], signal);
  const procs = new Map();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (m) procs.set(Number(m[1]), { parent: Number(m[2]), name: path.basename(m[3]) });
  }
  const pids = [];
  for (const [pid, proc] of procs) {
    if (proc.name !== 'codex') continue;
    let parent = proc.parent;
    const seen = new Set([pid]);
    while (parent > 1 && !seen.has(parent)) {
      if (parent === shellPid) { pids.push(pid); break; }
      seen.add(parent);
      parent = procs.get(parent)?.parent;
    }
  }
  if (!pids.length || signal.aborted) return null;
  const open = await run('/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-Fn'], signal);
  for (const line of open.split('\n')) {
    if (!line.startsWith('n')) continue;
    const file = line.slice(1);
    if (!/^rollout-.+\.jsonl$/.test(path.basename(file))) continue;
    const checked = await within(file, path.join(os.homedir(), '.codex', 'sessions'));
    if (checked) return checked;
  }
  return recentRollout(pids, signal);
}

// 対話の codex は記録のファイルを開いたままにしないことがある。
// そのときは、今日と昨日の記録のうち、codex の作業場所で始まり、直近5分に書かれた最も新しいものを使う
async function recentRollout(pids, signal) {
  const cwds = new Set();
  const out = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], signal);
  for (const line of out.split('\n')) if (line.startsWith('n')) cwds.add(line.slice(1));
  if (!cwds.size || signal.aborted) return null;
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const pad = (n) => String(n).padStart(2, '0');
  const days = [0, 1].map((back) => {
    const d = new Date(Date.now() - back * 86400000);
    return path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  });
  const candidates = [];
  for (const dir of days) {
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!/^rollout-.+\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile() && Date.now() - stat.mtimeMs < 5 * 60 * 1000) candidates.push({ file, mtime: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    if (signal.aborted) return null;
    let fd;
    try {
      // 先頭の行（session_meta）だけを読み、作業場所を比べる
      fd = await fs.promises.open(file, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const meta = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
      if (meta?.type === 'session_meta' && cwds.has(meta.payload?.cwd)) return within(file, root);
    } catch { /* 先頭の行が長すぎる・壊れているものは使わない */ }
    finally { await fd?.close().catch(() => {}); }
  }
  return null;
}

async function lookup(entry, signal) {
  if (process.env.TERP_SELFTEST) {
    if (!testLookup || !process.env.TERP_REPLY_FAKE_DIR) return null;
    const fake = await testLookup(entry);
    if (!fake) return null;
    if (fake.kind === 'claude') return { kind: 'claude', file: await claudeFile(fake.sessionId) };
    if (fake.kind === 'codex') return { kind: 'codex', file: await within(fake.file, process.env.TERP_REPLY_FAKE_DIR) };
    return null;
  }
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) return null;
  if (entry.program === 'claude') {
    const cached = sessions.get(entry.pid);
    if (!cached || Date.now() - cached.at >= SESSIONS_TTL) {
      sessions.delete(entry.pid);
      rememberSessions(await lookupSessions([entry.pid], signal));
    }
    const sessionId = sessions.get(entry.pid)?.sessionId;
    return { kind: 'claude', file: await claudeFile(sessionId) };
  }
  return { kind: 'codex', file: await codexFile(entry.pid, signal) };
}

async function find(entry, id) {
  const controller = new AbortController();
  const deadline = Date.now() + WAIT_MS;
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, WAIT_MS); });
  const poll = async () => {
    let source;
    do {
      source = source?.file ? source : await lookup(entry, controller.signal);
      if (controller.signal.aborted) return null;
      if (source?.file) {
        const text = await readReply(source.file, source.kind);
        const body = formatReply(text);
        const signature = createHash('sha256').update(text).digest('hex');
        if (body && signature !== used.get(id)) return { body, signature };
      }
      if (!process.env.TERP_SELFTEST && !['claude', 'codex'].includes(entry.program)) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    } while (!controller.signal.aborted);
    return null;
  };
  try { return await Promise.race([poll().catch(() => null), expired]); }
  finally { clearTimeout(timer); controller.abort(); }
}

module.exports = {
  formatReply, find, rememberSessions, codexFile,
  remember: (id, reply) => used.set(id, reply.signature),
  forget: (id) => used.delete(id),
  __test: process.env.TERP_SELFTEST ? {
    readReply, extract, claudeFile, codexFile, lookupSessions,
    setLookup: (fn) => { testLookup = fn; },
  } : undefined,
};

if (require.main === module && process.argv[2] === '--claude-sessions' && !process.env.TERP_SELFTEST) {
  require('./snapshot').claudeSessions(process.argv.slice(3).map(Number))
    .then((map) => process.stdout.write(JSON.stringify([...map])))
    .catch(() => process.stdout.write('[]'));
}
