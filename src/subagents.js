// Claude Code の記録と、シェルの下で動く Codex を読む。記録には書き込まない
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const snapshot = require('./snapshot');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const INITIAL_BYTES = 1024 * 1024;
const codexStarts = new Map();
// claude agents --json は CLI の起動を伴い重いため、シェルと会話の結び付けはこの間だけ使い回す
const SESSIONS_TTL = 15 * 1000;
let sessionsCache = { at: 0, key: '', map: new Map() };

async function cachedSessions(claudePids) {
  const key = [...claudePids].sort((a, b) => a - b).join(',');
  if (!key) return new Map();
  if (key !== sessionsCache.key || Date.now() - sessionsCache.at > SESSIONS_TTL) {
    sessionsCache = { at: Date.now(), key, map: await snapshot.claudeSessions(claudePids) };
  }
  return sessionsCache.map;
}

function claudeDirs() {
  return process.env.TERP_CLAUDE_DIRS
    ? process.env.TERP_CLAUDE_DIRS.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir))
    : ['.claude', '.claude2'].map((dir) => path.join(os.homedir(), dir));
}

function children(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 途中の行は読まない。末尾が書きかけでも、直前までの行は使える
function lines(buffer, skipFirst = false) {
  const text = buffer.toString('utf8');
  const rows = text.split('\n');
  if (skipFirst) rows.shift();
  return rows.map(parse).filter(Boolean);
}

function range(fd, start, length) {
  const buffer = Buffer.alloc(length);
  const count = fs.readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, count);
}

function firstTimestamp(head) {
  const firstLine = head.toString('utf8').split('\n', 1)[0];
  const first = parse(firstLine);
  if (typeof first?.timestamp === 'string') return first.timestamp;
  // 最初の行が 64 KB を超えても、読めた範囲の最上位の timestamp は使う。
  // JSON の文字列を丸ごと飛ばし、本文中の偽キーや入れ子の timestamp を拾わない
  if (!firstLine.trimStart().startsWith('{')) return null;
  const string = /"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/y;
  let depth = 0;
  let previous = '';
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i];
    if (/\s/.test(char)) continue;
    if (char === '"') {
      string.lastIndex = i;
      const token = string.exec(firstLine);
      if (!token) return null;
      i = string.lastIndex - 1;
      if (depth === 1 && ['{', ','].includes(previous) && parse(token[0]) === 'timestamp') {
        const value = firstLine.slice(i + 1).match(/^\s*:\s*("(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")/);
        return value ? parse(value[1]) : null;
      }
      previous = '"';
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth === 0) return null;
    previous = char;
  }
  return null;
}

function short(text, length = 120) {
  return String(text || '').split(/\r?\n/, 1)[0].slice(0, length);
}

function toolText(block) {
  const name = String(block.name || '道具');
  let summary = '';
  if (name === 'Bash') summary = short(block.input?.command);
  else if (['Read', 'Edit', 'Write'].includes(name) && typeof block.input?.file_path === 'string') {
    summary = path.basename(block.input.file_path);
  }
  return summary ? `${name}: ${summary}` : name;
}

function content(row) {
  const value = row.message?.content;
  return typeof value === 'string' ? [{ type: 'text', text: value }] : Array.isArray(value) ? value : [];
}

function lastAction(rows) {
  let fallback = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type !== 'assistant') continue;
    const blocks = content(rows[i]);
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j].type === 'tool_use') return toolText(blocks[j]);
      if (!fallback && blocks[j].type === 'text') fallback = String(blocks[j].text || '').slice(0, 60);
    }
  }
  return fallback;
}

function claudeAgent(dir, name) {
  const id = name.slice(6, -10);
  const file = path.join(dir, `agent-${id}.jsonl`);
  let fd;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    // シンボリックリンクで記録の外へ出ないよう、一覧と読み込みで同じ検査をする
    const checked = recordFile(file);
    fd = fs.openSync(checked, 'r');
    const stat = fs.fstatSync(fd);
    const head = range(fd, 0, Math.min(stat.size, HEAD_BYTES));
    const startedAt = firstTimestamp(head);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = range(fd, start, stat.size - start);
    return {
      id,
      kind: 'claude',
      description: typeof meta.description === 'string' ? meta.description : 'サブエージェント',
      agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
      running: meta.finished !== true && Date.now() - stat.mtimeMs < 10 * 60 * 1000,
      startedAt: startedAt || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      lastAction: lastAction(lines(tail, start > 0 && range(fd, start - 1, 1)[0] !== 10)),
      file: checked,
    };
  } catch {
    // 書きかけの meta や消えた記録は、次の読み直しに任せる
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function claudeAgents(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /[\\/]/.test(sessionId) || ['.', '..'].includes(sessionId)) return [];
  const found = new Map();
  for (const base of claudeDirs()) {
    const projects = path.join(base, 'projects');
    for (const project of children(projects)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(projects, project.name, sessionId, 'subagents');
      for (const entry of children(dir)) {
        if (!entry.isFile() || !/^agent-.+\.meta\.json$/.test(entry.name)) continue;
        const agent = claudeAgent(dir, entry.name);
        if (agent) found.set(agent.file, agent);
      }
    }
  }
  const agents = [...found.values()].sort(newest);
  let finished = 0;
  return agents.filter((agent) => agent.running || ++finished <= 20);
}

function newest(a, b) {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);
}

function runPs() {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
    } catch {
      resolve('');
    }
  });
}

function elapsedSeconds(value) {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const parts = clock.split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(days) * 86400 + seconds;
}

function codexAgents(output, shellPids) {
  const procs = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) procs.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3], command: match[4] });
  }
  const shells = new Set(shellPids);
  const result = new Map(shellPids.map((pid) => [pid, []]));
  const candidates = new Map();
  for (const proc of procs.values()) {
    const args = [...proc.command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const executable = path.basename(args[0] || '');
    const index = executable === 'codex' ? 0 : /^node(?:js)?$/.test(executable) && /^codex(?:\.js)?$/.test(path.basename(args[1] || '')) ? 1 : -1;
    if (index >= 0 && args.slice(index + 1).includes('exec')) candidates.set(proc.pid, { ...proc, args });
  }
  const active = new Set();
  for (const proc of candidates.values()) {
    let pid = proc.ppid;
    const seen = new Set([proc.pid]);
    let shell = null;
    while (pid > 1 && !seen.has(pid)) {
      if (shells.has(pid)) { shell = pid; break; }
      // node の起動役と実行本体が両方見えるときは、起動役だけを出す
      if (candidates.has(pid)) break;
      seen.add(pid);
      pid = procs.get(pid)?.ppid;
    }
    if (!shell) continue;
    active.add(proc.pid);
    if (!codexStarts.has(proc.pid)) codexStarts.set(proc.pid, new Date(Date.now() - elapsedSeconds(proc.elapsed) * 1000).toISOString());
    const cwdIndex = proc.args.indexOf('-C');
    const cwd = cwdIndex >= 0 ? proc.args[cwdIndex + 1] : null;
    const startedAt = codexStarts.get(proc.pid);
    result.get(shell).push({ id: `codex:${proc.pid}`, kind: 'codex', description: cwd ? path.basename(cwd) || cwd : 'Codex', agentType: 'Codex', running: true, startedAt, updatedAt: startedAt, lastAction: '', file: null });
  }
  for (const pid of codexStarts.keys()) if (!active.has(pid)) codexStarts.delete(pid);
  return result;
}

// claudePids は、前面で claude が動いているシェルの pid。会話の結び付けはこのシェルだけを調べる
async function list(shellPids, claudePids = shellPids) {
  const pids = [...new Set(shellPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!pids.length) return new Map();
  const fake = process.env.TERP_SELFTEST && process.env.TERP_FAKE_CLAUDE_SESSION;
  const [sessions, ps] = await Promise.all([
    fake ? new Map(pids.map((pid) => [pid, fake])) : cachedSessions(claudePids.filter((pid) => pids.includes(pid))),
    runPs(),
  ]);
  const result = codexAgents(ps, pids);
  const conversations = new Map();
  for (const pid of pids) {
    const session = sessions.get(pid);
    if (session && !conversations.has(session)) conversations.set(session, claudeAgents(session));
    result.set(pid, [...(conversations.get(session) || []), ...result.get(pid)].sort(newest));
  }
  return result;
}

function recordFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('記録の場所が正しくありません');
  const real = fs.realpathSync(file);
  for (const dir of claudeDirs()) {
    let root;
    try { root = fs.realpathSync(dir); } catch { continue; }
    const parts = path.relative(root, real).split(path.sep);
    if (parts.length === 5 && parts[0] === 'projects' && parts[1] && parts[2] && parts[3] === 'subagents' && /^agent-.+\.jsonl$/.test(parts[4])) {
      if (fs.statSync(real).isFile()) return real;
    }
  }
  throw new Error('サブエージェントの記録だけを開けます');
}

function resultText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
  return '';
}

function display(row) {
  if (!row || !['user', 'assistant'].includes(row.type)) return [];
  const at = typeof row.timestamp === 'string' ? row.timestamp : '';
  return content(row).flatMap((block) => {
    if (block.type === 'text') return [{ t: 'text', at, text: String(block.text || '') }];
    if (block.type === 'tool_use') return [{ t: 'tool', at, text: toolText(block) }];
    if (block.type === 'tool_result') return [{ t: 'result', at, text: resultText(block.content).slice(0, 400) }];
    return [];
  });
}

async function read(file, offset) {
  const checked = recordFile(file);
  const fd = fs.openSync(checked, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('記録の読み取り位置が正しくありません');
    let start = offset === undefined || offset > stat.size ? Math.max(0, stat.size - INITIAL_BYTES) : offset;
    const skipFirst = start > 0 && range(fd, start - 1, 1)[0] !== 10 && (offset === undefined || offset > stat.size);
    const entries = [];
    let fragments = [];
    let position = start;
    let skipping = skipFirst;
    // 大きな api-request-blob が混ざっても、一度に全ファイルを読まない
    while (position < stat.size) {
      const chunk = range(fd, position, Math.min(HEAD_BYTES, stat.size - position));
      if (!chunk.length) break;
      let end;
      let consumed = 0;
      while ((end = chunk.indexOf(10, consumed)) >= 0) {
        fragments.push(chunk.subarray(consumed, end));
        if (!skipping) entries.push(...display(parse(Buffer.concat(fragments).toString('utf8'))));
        skipping = false;
        consumed = end + 1;
        start = position + consumed;
        fragments = [];
      }
      if (consumed < chunk.length) fragments.push(chunk.subarray(consumed));
      position += chunk.length;
    }
    // 最終行が書きかけなら、次回も同じ位置から読む。完成した JSON は改行がなくても使える
    const last = !skipping && fragments.length ? parse(Buffer.concat(fragments).toString('utf8')) : null;
    if (last) {
      entries.push(...display(last));
      start = position;
    }
    return { entries, offset: start };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { list, read };
