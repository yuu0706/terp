// 手元に入っている AI エージェントの CLI を探す。ターミナルで打って動くものと揃えるため、
// ログインシェルの PATH から探す
const fs = require('fs');
const path = require('path');
const { loginEnv } = require('./git');

// よく使われるもの。設定ファイルの agents に書いたものは、この後ろに足す。
// bypassArgs は、ファイルの読み書きやコマンドの実行の確認を飛ばして起動する引数。
// Orca の agentDefaultArgs と同じものにしている（2026-10-23 に利用者の Orca の設定で確認）。
// OpenCode と Goose は Orca にも登録が無いため持たない
const KNOWN_AGENTS = [
  { command: 'claude', label: 'Claude Code', bypassArgs: '--dangerously-skip-permissions' },
  { command: 'codex', label: 'Codex', bypassArgs: '--dangerously-bypass-approvals-and-sandbox' },
  { command: 'gemini', label: 'Gemini CLI', bypassArgs: '--yolo' },
  { command: 'opencode', label: 'OpenCode' },
  { command: 'cursor-agent', label: 'Cursor Agent', bypassArgs: '--yolo' },
  { command: 'copilot', label: 'Copilot CLI', bypassArgs: '--yolo' },
  { command: 'aider', label: 'Aider', bypassArgs: '--yes-always' },
  { command: 'amp', label: 'Amp', bypassArgs: '--dangerously-allow-all' },
  { command: 'qwen', label: 'Qwen Code', bypassArgs: '--approval-mode yolo' },
  { command: 'goose', label: 'Goose' },
  { command: 'crush', label: 'Crush', bypassArgs: '--yolo' },
  { command: 'droid', label: 'Droid', bypassArgs: '--auto high' },
];

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// command は名前（PATH から探す）か絶対パス。args は起動のときに付ける引数
async function detect(extra = []) {
  const env = await loginEnv();
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const agent of [...KNOWN_AGENTS, ...extra]) {
    if (!agent || typeof agent.command !== 'string' || seen.has(agent.command)) continue;
    const command = agent.command.trim();
    const where = path.isAbsolute(command)
      ? isExecutable(command) && command
      : dirs.map((d) => path.join(d, command)).find(isExecutable);
    if (!where) continue;
    seen.add(agent.command);
    found.push({
      command,
      label: agent.label || path.basename(command),
      args: typeof agent.args === 'string' ? agent.args : '',
      bypassArgs: typeof agent.bypassArgs === 'string' ? agent.bypassArgs : '',
      path: where,
    });
  }
  return found;
}

module.exports = { detect, KNOWN_AGENTS };
