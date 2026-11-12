// AI エージェントの会話の履歴（~/.config/terp/agent-history.json）。
// terp のターミナルで動いた claude・codex の会話の ID・作業場所・題名・使った時刻を残し、⌘M の一覧から再開する
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const HISTORY_PATH = path.join(CONFIG_DIR, 'agent-history.json');
const MAX_ENTRIES = 200;
const AGENTS = new Set(['claude', 'codex']);
// 会話の ID は claude・codex とも UUID。シェルに打つため、それ以外の文字を含むものは残さない
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 300) : '';
}

function valid(entry) {
  return entry && AGENTS.has(entry.agent) && SESSION_ID.test(entry.sessionId || '') && typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd);
}

// claude を既定以外の設定のフォルダ（CLAUDE_CONFIG_DIR）で動かしたときだけ残す。再開するときに同じフォルダを渡す
function configDir(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return (Array.isArray(data.entries) ? data.entries : []).filter(valid).map((e) => ({
      agent: e.agent, sessionId: e.sessionId, cwd: e.cwd, workspace: text(e.workspace) || null,
      title: text(e.title), name: text(e.name), configDir: configDir(e.configDir),
      startedAt: Number.isFinite(e.startedAt) ? e.startedAt : 0, lastUsed: Number.isFinite(e.lastUsed) ? e.lastUsed : 0,
    }));
  } catch {
    return [];
  }
}

function save(entries) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = JSON.stringify({ entries }, null, 2) + '\n';
  // 書きかけのファイルを読まれないよう、別名で書いてから置き換える
  const tmp = `${HISTORY_PATH}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, HISTORY_PATH);
}

// 今動いている会話を書き足す。同じ会話は1件にまとめ、使った時刻と題名を新しくする。
// 題名が空のとき（起動直後など）は前の題名を残す。変わったときだけ書き込む
function record(seen, now = Date.now()) {
  const fresh = seen.filter(valid);
  if (!fresh.length) return false;
  const entries = load();
  let changed = false;
  for (const item of fresh) {
    const found = entries.find((e) => e.agent === item.agent && e.sessionId === item.sessionId);
    const title = text(item.title);
    const name = text(item.name);
    if (found) {
      const next = { ...found, cwd: item.cwd, workspace: text(item.workspace) || found.workspace, configDir: configDir(item.configDir),
        title: title || found.title, name: name || found.name, lastUsed: now };
      if (JSON.stringify(next) !== JSON.stringify(found)) changed = true;
      Object.assign(found, next);
    } else {
      entries.push({ agent: item.agent, sessionId: item.sessionId, cwd: item.cwd, workspace: text(item.workspace) || null,
        title, name, configDir: configDir(item.configDir), startedAt: now, lastUsed: now });
      changed = true;
    }
  }
  if (!changed) return false;
  entries.sort((a, b) => b.lastUsed - a.lastUsed);
  save(entries.slice(0, MAX_ENTRIES));
  return true;
}

// 一覧から消す
function remove(agent, sessionId) {
  const entries = load();
  const next = entries.filter((e) => !(e.agent === agent && e.sessionId === sessionId));
  if (next.length !== entries.length) save(next);
}

// codex の記録のファイル名（rollout-<日時>-<UUID>.jsonl）から会話の ID を取り出す
function codexSessionId(file) {
  const m = typeof file === 'string' && path.basename(file).match(/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

module.exports = { load, record, remove, codexSessionId, HISTORY_PATH, MAX_ENTRIES };
