// 「変更」の面で使う git の操作。変更を捨てる操作（restore・reset --hard など）は取り返しがつかないため持たない
const fs = require('fs');
const { git } = require('./git');

// 差分が大きすぎると画面が固まるため、この行数で打ち切る
const DIFF_LINE_LIMIT = 5000;
// プッシュ・プル・フェッチは通信を伴うため長めに待つ
const NETWORK_TIMEOUT = 120000;

// その場所を含む worktree の一番上。git の外なら null
async function toplevel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    return (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  } catch {
    return null;
  }
}

// git status --porcelain=v2 -z を読む
function parseStatus(out) {
  const result = { branch: '', upstream: '', ahead: 0, behind: 0, oid: '', staged: [], unstaged: [], conflicted: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) result.branch = line.slice(14);
    else if (line.startsWith('# branch.oid ')) result.oid = line.slice(13);
    else if (line.startsWith('# branch.upstream ')) result.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (line[0] === '1' || line[0] === '2') {
      const fields = line.split(' ');
      const xy = fields[1];
      // 種類 2（名前の変更）は、パスの後ろの要素に元の名前が入る
      const file = fields.slice(line[0] === '1' ? 8 : 9).join(' ');
      const from = line[0] === '2' ? parts[++i] : null;
      if (xy[0] !== '.') result.staged.push({ path: file, from, code: xy[0] });
      if (xy[1] !== '.') result.unstaged.push({ path: file, from: null, code: xy[1] });
    } else if (line[0] === 'u') {
      result.conflicted.push({ path: line.split(' ').slice(10).join(' '), code: 'U' });
    } else if (line[0] === '?') {
      result.unstaged.push({ path: line.slice(2), from: null, code: '?' });
    }
  }
  return result;
}

async function status(dir) {
  const top = await toplevel(dir);
  if (!top) return null;
  const out = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], top);
  const st = parseStatus(out);
  const [name, email] = await Promise.all([
    git(['config', 'user.name'], top).catch(() => ''),
    git(['config', 'user.email'], top).catch(() => ''),
  ]);
  return { top, ...st, identity: { name: name.trim(), email: email.trim() } };
}

// kind は staged（ステージ済み）・unstaged（未ステージ）・untracked（追跡外）
async function diff(top, file, kind) {
  let out;
  if (kind === 'untracked') {
    out = await git(['diff', '--no-color', '--no-index', '--', '/dev/null', file], top, { okCodes: [0, 1] });
  } else {
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (kind === 'staged') args.push('--cached');
    out = await git([...args, '--', file], top);
  }
  const lines = out.split('\n');
  const truncated = lines.length > DIFF_LINE_LIMIT;
  return { text: (truncated ? lines.slice(0, DIFF_LINE_LIMIT) : lines).join('\n'), truncated, binary: /^Binary files /m.test(out) };
}

async function hasHead(top) {
  return git(['rev-parse', '--verify', '--quiet', 'HEAD'], top).then(
    () => true,
    () => false,
  );
}

async function stage(top, files) {
  await git(['add', '--', ...files], top);
}

async function unstage(top, files) {
  // 最初のコミットの前は HEAD が無いため restore --staged が使えない
  if (await hasHead(top)) await git(['restore', '--staged', '--', ...files], top);
  else await git(['rm', '--cached', '--quiet', '--', ...files], top);
}

// フック（pre-commit など）もターミナルと同じく走る
async function commit(top, message) {
  return git(['commit', '--file=-'], top, { input: message, timeout: NETWORK_TIMEOUT });
}

async function push(top) {
  const st = await status(top);
  // 上流が無いブランチは、origin に同じ名前で作って追跡する
  const args = st.upstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD'];
  const out = await git(args, top, { timeout: NETWORK_TIMEOUT });
  return out;
}

// 履歴が分かれているときは自動でマージしない（--ff-only）。分かれていたら失敗として返す
async function pull(top) {
  return git(['pull', '--ff-only'], top, { timeout: NETWORK_TIMEOUT });
}

async function fetch(top) {
  return git(['fetch', '--prune'], top, { timeout: NETWORK_TIMEOUT });
}

module.exports = { toplevel, status, diff, stage, unstage, commit, push, pull, fetch, parseStatus, DIFF_LINE_LIMIT };
