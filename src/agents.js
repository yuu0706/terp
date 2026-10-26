// 手元に入っている AI エージェントの CLI を探す。ターミナルで打って動くものと揃えるため、
// ログインシェルの PATH から探す
const fs = require('fs');
const path = require('path');
const { loginEnv } = require('./git');

// 設定ファイルの agents に書いた値を重ね、書いた順を優先する。
// bypassArgs は、ファイルの読み書きやコマンドの実行の確認を飛ばして起動する引数。
// 一覧と既定の引数は Orca 本体から読み取ったもの（2026-10-26）。CodeRabbit は terp で追加。
// OpenCode と Goose は確認を飛ばす既定の引数を持たない
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
  { command: 'coderabbit', label: 'CodeRabbit', aliases: ['cr'] },
  { command: 'codebuddy', icon: { file: 'codebuddy.svg', mode: 'image' }, label: 'CodeBuddy', aliases: ['cbc'], bypassArgs: '--dangerously-skip-permissions' },
  { command: 'openclaude', label: 'OpenClaude', bypassArgs: '--dangerously-skip-permissions' },
  { command: 'qodercli', icon: { file: 'qodercli.svg', mode: 'image' }, label: 'Qoder CLI', aliases: ['qoder'], bypassArgs: '--dangerously-skip-permissions' },
  { command: 'qoderclicn', icon: { file: 'qodercli.svg', mode: 'image' }, label: 'Qoder CLI China', aliases: ['qodercn'], bypassArgs: '--dangerously-skip-permissions' },
  { command: 'agy', icon: { file: 'agy.svg', mode: 'image' }, label: 'Antigravity', bypassArgs: '--dangerously-skip-permissions' },
  { command: 'traecli', icon: { file: 'traecli.svg', mode: 'image' }, label: 'Trae', bypassArgs: '--yolo' },
  { command: 'kiro-cli', icon: { file: 'kiro-cli.svg', mode: 'image' }, label: 'Kiro', bypassArgs: '--trust-all-tools' },
  { command: 'kimi', icon: { file: 'kimi.svg', mode: 'image' }, label: 'Kimi', aliases: ['kimi-code'], bypassArgs: '--yolo' },
  { command: 'vibe', icon: { file: 'vibe.svg', mode: 'image' }, label: 'Mistral Vibe', aliases: ['mistral-vibe'], bypassArgs: '--agent auto-approve' },
  { command: 'devin', icon: { file: 'devin.svg', mode: 'image' }, label: 'Devin', bypassArgs: '--permission-mode bypass --respect-workspace-trust false' },
  { command: 'dsh-tui', icon: { file: 'dsh-tui.svg', mode: 'image' }, label: 'DeepSeek Harness', aliases: ['dst'] },
  { command: 'muse', icon: { file: 'muse.svg', mode: 'image' }, label: 'Muse', bypassArgs: '--yolo' },
  { command: 'grok', icon: { file: 'grok.svg', mode: 'mask' }, label: 'Grok', bypassArgs: '--permission-mode bypassPermissions' },
  { command: 'hermes', icon: { file: 'hermes.svg', mode: 'mask' }, label: 'Hermes', bypassArgs: '--yolo' },
  { command: 'cline', icon: { file: 'cline.svg', mode: 'mask' }, label: 'Cline', bypassArgs: '--auto-approve true' },
  { command: 'kilo', icon: { file: 'kilo.svg', mode: 'mask' }, label: 'Kilo Code' },
  { command: 'command-code', icon: { file: 'command-code.svg', mode: 'mask' }, label: 'Command Code', bypassArgs: '--yolo' },
  { command: 'zcode', icon: { file: 'zcode.svg', mode: 'mask' }, label: 'ZCode', bypassArgs: '--mode yolo' },
  { command: 'mimo', icon: { file: 'mimo.svg', mode: 'mask' }, label: 'MiMo Code' },
  { command: 'opencode2', icon: { file: 'opencode.svg', mode: 'mask' }, label: 'OpenCode 2' },
  { command: 'cn', label: 'Continue', bypassArgs: '--allow "*"' },
  { command: 'acli', label: 'Rovo Dev', args: 'rovodev run', bypassArgs: '--yolo' },
  { command: 'auggie', label: 'Auggie' },
  { command: 'autohand', label: 'Autohand', bypassArgs: '--unrestricted' },
  { command: 'ante', label: 'Ante', bypassArgs: '--yolo' },
  { command: 'pi', label: 'Pi' },
  { command: 'omp', label: 'OMP' },
  { command: 'prime-agent', label: 'Prime Agent' },
  { command: 'codebuff', label: 'Codebuff' },
  { command: 'freebuff', label: 'Freebuff' },
  { command: 'jcode', label: 'Jcode' },
  { command: 'openclaw', label: 'OpenClaw' },
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
    const targets = override ? [override] : [command, ...(defaults.aliases || [])];
    let where;
    let alias = null;
    for (const target of targets) {
      where = override || path.isAbsolute(target)
        ? path.isAbsolute(target) && isExecutable(target) && target
        : dirs.map((d) => path.join(d, target)).find(isExecutable);
      if (where) {
        if (!override && target !== command) alias = target;
        break;
      }
    }
    return {
      command,
      label: typeof agent.label === 'string' && agent.label ? agent.label : defaults.label || path.basename(command),
      args: typeof agent.args === 'string' ? agent.args : '',
      bypassArgs: typeof agent.bypassArgs === 'string' ? agent.bypassArgs : '',
      path: where || null,
      alias,
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
