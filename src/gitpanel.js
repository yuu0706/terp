// 「変更」の面で使う git の操作。履歴ごと捨てる操作（reset --hard など）は取り返しがつかないため持たない。
// 未ステージの変更の取り消し（discard）だけは、今の中身をゴミ箱へ控えてから行う（2026-10-30 利用者の指示）
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// 未ステージの変更を取り消す（2026-10-30 利用者の指示。押す前に画面で確かめる）。
// 取り消した変更は git では戻せないため、今の中身を先にゴミ箱へ控える。ゴミ箱へ移す処理（trash）は本体から受け取る。
// 追跡外のファイルはファイルそのものをゴミ箱へ移す。追跡しているファイルはステージした内容（無ければコミット済み）に戻し、ステージは変えない
async function discard(top, files, { trash }) {
  const st = await status(top);
  if (!st || st.top !== top) throw new Error('リポジトリが見つかりません');
  const unstaged = new Map(st.unstaged.map((f) => [f.path, f.code]));
  const outside = files.filter((file) => {
    const full = path.resolve(top, file);
    return full === top || !full.startsWith(`${top}${path.sep}`);
  });
  if (outside.length) throw new Error(`リポジトリの外のファイルは取り消せません: ${outside.join(', ')}`);
  const missing = files.filter((file) => !unstaged.has(file));
  if (missing.length) throw new Error(`未ステージの変更がありません: ${missing.join(', ')}`);
  const untracked = files.filter((file) => unstaged.get(file) === '?');
  const tracked = files.filter((file) => unstaged.get(file) !== '?');
  if (tracked.length) {
    const kept = tracked.filter((file) => fs.existsSync(path.join(top, file)));
    if (kept.length) {
      // ゴミ箱で見分けられるよう、控えのフォルダにリポジトリの名前と時刻を付け、元のフォルダの形のまま写す
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'terp-discard-')), `${path.basename(top)} の取り消し前 ${stamp}`);
      for (const file of kept) {
        fs.mkdirSync(path.dirname(path.join(backup, file)), { recursive: true });
        fs.copyFileSync(path.join(top, file), path.join(backup, file));
      }
      await trash(backup);
    }
    await git(['restore', '--worktree', '--', ...tracked], top);
  }
  for (const file of untracked) await trash(path.join(top, file));
  return { restored: tracked.length, trashed: untracked.length };
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

// コミットメッセージを AI に作らせるための材料。差分は長いと途中で切る
const COMMIT_DIFF_LIMIT = 12000;
async function stagedSummary(top) {
  const [stat, full, log] = await Promise.all([
    git(['diff', '--cached', '--stat'], top),
    git(['diff', '--cached', '--no-color', '--no-ext-diff'], top),
    git(['log', '-8', '--format=%s'], top).catch(() => ''),
  ]);
  return {
    stat: stat.trim(),
    diff: full.length > COMMIT_DIFF_LIMIT ? `${full.slice(0, COMMIT_DIFF_LIMIT)}\n（以下略）` : full,
    subjects: log.split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

module.exports = { toplevel, status, diff, stage, unstage, discard, commit, push, pull, fetch, parseStatus, stagedSummary, DIFF_LINE_LIMIT };
