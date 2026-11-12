// CLI の実行は登録画面を開いたときだけ行う。認証の生出力は IPC へ渡さない
const { execFile } = require('child_process');
const path = require('path');
const { loginEnv } = require('./git');
const { CONFIG_DIR } = require('./config');
const { detect } = require('./agents');

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: CONFIG_DIR, env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
  });
}

// 認証方式の語だけを許し、改行や付加情報を表示しない
function methodWord(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(value) ? value : '';
}

async function inspect(agent, env) {
  const status = { command: agent.command, version: '', login: 'unsupported', method: '' };
  const name = path.basename(agent.command);
  const supportsAuth = name === 'claude' || name === 'codex';
  if (supportsAuth) status.login = 'unknown';
  if (!agent.found) return status;
  // 偽のフォルダに無い実行ファイルを本物へフォールバックさせない
  const file = process.env.TERP_AGENT_STATUS_FAKE
    ? path.join(process.env.TERP_AGENT_STATUS_FAKE, name) : agent.path;
  const version = await run(file, ['--version'], env);
  if (version.ok) status.version = (version.stdout || version.stderr).split(/\r?\n/)[0].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  if (!supportsAuth) return status;
  const auth = await run(file, name === 'claude' ? ['auth', 'status'] : ['login', 'status'], env);
  if (!auth.ok) return status;
  if (name === 'claude') {
    try {
      const value = JSON.parse(auth.stdout);
      if (typeof value.loggedIn !== 'boolean') return status;
      status.login = value.loggedIn ? 'in' : 'out';
      status.method = methodWord(value.authMethod);
    } catch {
      // JSON 以外の出力には認証情報が混ざる可能性があるため表示しない
    }
  } else {
    // Codex の版によっては状態を標準エラー出力へ書く
    const text = (auth.stdout || auth.stderr).trim();
    status.login = text.startsWith('Logged in') ? 'in' : 'out';
    status.method = status.login === 'in' ? methodWord(text.match(/^Logged in using ([^\s]+)/)?.[1]) : '';
  }
  return status;
}

async function check(extra = []) {
  const [agents, env] = await Promise.all([detect(extra), loginEnv()]);
  const statuses = await Promise.all(agents.map((agent) => inspect(agent, env)));
  return statuses;
}

module.exports = { check };
