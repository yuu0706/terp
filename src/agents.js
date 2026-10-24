// 手元に入っている AI エージェントの CLI を探す。ターミナルで打って動くものと揃えるため、
// ログインシェルの PATH から探す
const fs = require('fs');
const path = require('path');
const { loginEnv } = require('./git');

// よく使われるもの。設定ファイルの agents に書いた値を重ね、書いた順を優先する。
// bypassArgs は、ファイルの読み書きやコマンドの実行の確認を飛ばして起動する引数。
// Orca の agentDefaultArgs と同じものにしている（2026-10-23 に利用者の Orca の設定で確認）。
// OpenCode と Goose は Orca にも登録が無いため持たない
const KNOWN_AGENTS = [
  { command: 'claude', icon: { file: 'claude.svg', mode: 'image' }, label: 'Claude Code', bypassArgs: '--dangerously-skip-permissions' },
  { command: 'codex', icon: { file: 'codex.svg', mode: 'image' }, label: 'Codex', bypassArgs: '--dangerously-bypass-approvals-and-sandbox' },
  { command: 'gemini', icon: { file: 'gemini.svg', mode: 'image' }, label: 'Gemini CLI', bypassArgs: '--yolo' },
  { command: 'opencode', icon: { file: 'opencode.svg', mode: 'mask' }, label: 'OpenCode' },
  { command: 'cursor-agent', icon: { file: 'cursor-agent.svg', mode: 'mask' }, label: 'Cursor Agent', bypassArgs: '--yolo' },
  { command: 'copilot', icon: { file: 'copilot.svg', mode: 'image' }, label: 'Copilot CLI', bypassArgs: '--yolo' },
  { command: 'aider', label: 'Aider', bypassArgs: '--yes-always' },
  { command: 'amp', icon: { file: 'amp.svg', mode: 'image' }, label: 'Amp', bypassArgs: '--dangerously-allow-all' },
  { command: 'qwen', icon: { file: 'qwen.svg', mode: 'image' }, label: 'Qwen Code', bypassArgs: '--approval-mode yolo' },
  { command: 'goose', icon: { file: 'goose.svg', mode: 'mask' }, label: 'Goose' },
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

// 設定に書かれた項目を先に並べ、未導入のものも登録画面へ返す
async function detect(extra = []) {
  const env = await loginEnv();
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  const known = new Map(KNOWN_AGENTS.map((a) => [a.command, a]));
  const configured = new Map();
  for (const item of Array.isArray(extra) ? extra : []) {
    if (!item || typeof item.command !== 'string' || !item.command.trim()) continue;
    const command = item.command.trim();
    configured.set(command, { ...configured.get(command), ...item, command });
  }
  const commands = [...configured.keys(), ...known.keys()].filter((c, i, all) => all.indexOf(c) === i);
  return commands.map((command) => {
    const defaults = known.get(command) || {};
    const agent = { ...defaults, ...configured.get(command) };
    const override = typeof agent.path === 'string' && agent.path ? agent.path : '';
    const target = override || command;
    const where = override || path.isAbsolute(target)
      ? path.isAbsolute(target) && isExecutable(target) && target
      : dirs.map((d) => path.join(d, target)).find(isExecutable);
    return {
      command,
      label: typeof agent.label === 'string' && agent.label ? agent.label : defaults.label || path.basename(command),
      args: typeof agent.args === 'string' ? agent.args : '',
      bypassArgs: typeof agent.bypassArgs === 'string' ? agent.bypassArgs : '',
      path: where || null,
      configuredPath: override,
      found: Boolean(where),
      hidden: agent.hidden === true,
      env: Object.fromEntries(Object.entries(agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env) ? agent.env : {})
        .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')),
      known: known.has(command),
      defaults: { label: defaults.label || '', args: defaults.args || '', bypassArgs: defaults.bypassArgs || '' },
      icon: defaults.icon || null,
    };
  });
}

module.exports = { detect, KNOWN_AGENTS };
