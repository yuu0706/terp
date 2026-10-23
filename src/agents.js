// 手元に入っている AI エージェントの CLI を探す。ターミナルで打って動くものと揃えるため、
// ログインシェルの PATH から探す
const fs = require('fs');
const path = require('path');
const { loginEnv } = require('./git');

// よく使われるもの。設定ファイルの agents に書いたものは、この後ろに足す
const KNOWN_AGENTS = [
  { command: 'claude', label: 'Claude Code' },
  { command: 'codex', label: 'Codex' },
  { command: 'gemini', label: 'Gemini CLI' },
  { command: 'opencode', label: 'OpenCode' },
  { command: 'cursor-agent', label: 'Cursor Agent' },
  { command: 'copilot', label: 'Copilot CLI' },
  { command: 'aider', label: 'Aider' },
  { command: 'amp', label: 'Amp' },
  { command: 'qwen', label: 'Qwen Code' },
  { command: 'goose', label: 'Goose' },
  { command: 'crush', label: 'Crush' },
  { command: 'droid', label: 'Droid' },
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
      path: where,
    });
  }
  return found;
}

module.exports = { detect, KNOWN_AGENTS };
