// 履歴は読むだけにし、作業ツリーと参照を変更する操作を持たない
const { git } = require('./git');
const { toplevel, DIFF_LINE_LIMIT } = require('./gitpanel');

const HASH = /^[0-9a-f]{4,40}$/i;
const FORMAT = '%x1e%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b%x00';

function validateHash(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('ハッシュは16進の4〜40字で指定');
}

function parseRefs(text, remoteNames) {
  return text.split(', ').filter(Boolean).flatMap((value) => {
    const current = value.startsWith('HEAD -> ');
    if (current) value = value.slice(8);
    if (value === 'HEAD') return [{ name: 'HEAD', kind: 'head', current: false }];
    if (value.startsWith('tag: ')) return [{ name: value.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag', current: false }];
    if (value.startsWith('refs/remotes/')) {
      const name = value.slice(13);
      const remote = remoteNames.find((r) => name.startsWith(r + '/'));
      if (!remote || name === remote + '/HEAD') return [];
      return [{ name, kind: 'remote', current: false }];
    }
    return [{ name: value.replace(/^refs\/heads\//, ''), kind: 'branch', current }];
  });
}

function parseLog(out, remoteNames, reachable) {
  return out.split('\0').filter((record) => record.trim()).map((record) => {
    const fields = record.slice(record.indexOf('\x1e') + 1).split('\x1f');
    const [hash, shortHash, parents, author, date, refs, subject] = fields;
    return { commit: {
      hash, shortHash, parents: parents ? parents.split(' ') : [], author, date,
      refs: parseRefs(refs, remoteNames), subject, hasBody: Boolean(fields.slice(7).join('\x1f')),
      reachable: reachable === null || reachable.has(hash),
    } };
  });
}

function isGithub(url) {
  try { return new URL(url).hostname.toLowerCase() === 'github.com'; }
  catch { return /^(?:[^@/:]+@)?github\.com:/i.test(url); }
}

async function log(dir, { limit = 100, skip = 0, all = false, path = null, query = '' } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(skip) || skip < 0) throw new Error('履歴の件数と開始位置を確認');
  if (path !== null && (typeof path !== 'string' || path.includes('\0'))) throw new Error('ファイルのパスを確認');
  if (typeof query !== 'string' || query.includes('\0')) throw new Error('絞り込みの文字を確認');
  const top = await toplevel(dir);
  if (!top) return null;
  const remoteNames = (await git(['remote'], top)).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
  const remotes = Object.fromEntries(await Promise.all(remoteNames.map(async (name) => [name, {
    github: isGithub((await git(['remote', 'get-url', '--', name], top)).trim()),
  }])));
  const unpushed = (await git(['rev-list', '@{u}..HEAD'], top).catch(() => '')).trim().split('\n').filter(Boolean);
  const exists = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], top).then(() => true, () => false);
  if (!exists && !all) return { top, rows: [], unpushed, remotes, nextSkip: null, hasMore: false };
  const reachable = all ? new Set(exists ? (await git(['rev-list', 'HEAD'], top)).trim().split('\n') : []) : null;
  const scope = all ? ['--all'] : ['HEAD'];
  const paths = path ? ['--', path] : ['--'];
  const base = ['--literal-pathspecs', 'log', '--topo-order', '--no-color', '--no-show-signature', '--decorate=full'];
  const parse = (out) => parseLog(out, remoteNames, reachable);
  query = query.trim();
  let rows;
  if (HASH.test(query)) {
    // ハッシュの検索は祖先をたどらず、そのコミットだけを返す
    const hash = (await git(['rev-parse', '--verify', `${query.toLowerCase()}^{commit}`], top)).trim();
    rows = parse(await git([...base, `--format=${FORMAT}`, '-1', `${hash}^!`, ...paths], top));
  } else if (query) {
    // --grep と --author は同時に指定すると AND になるため、集合を合わせてから枝の順に絞る
    const matches = await Promise.all(['--grep', '--author'].map((flag) => git([
      ...base, '--format=%H', '-i', '--fixed-strings', `${flag}=${query}`, ...scope, ...paths,
    ], top)));
    const subjects = new Set(matches[0].split('\n').filter(Boolean));
    const authors = new Set(matches[1].split('\n').filter(Boolean));
    const needle = query.toLocaleLowerCase();
    rows = !subjects.size && !authors.size ? [] : parse(await git([...base, `--format=${FORMAT}`, ...scope, ...paths], top)).filter(({ commit }) =>
      authors.has(commit.hash) || (subjects.has(commit.hash) && commit.subject.toLocaleLowerCase().includes(needle)));
  } else {
    rows = parse(await git([...base, `--format=${FORMAT}`, `--skip=${skip}`, `--max-count=${limit + 1}`, ...scope, ...paths], top));
  }
  const offset = query ? skip : 0;
  const hasMore = rows.length > offset + limit;
  return { top, rows: rows.slice(offset, offset + limit), unpushed, remotes, nextSkip: hasMore ? skip + limit : null, hasMore };
}

async function commit(dir, hash) {
  validateHash(hash);
  const top = await toplevel(dir);
  if (!top) throw new Error('git のリポジトリではありません');
  const full = (await git(['rev-parse', '--verify', `${hash.toLowerCase()}^{commit}`], top)).trim();
  const out = await git(['show', '-s', '--no-color', '--no-show-signature', '--decorate=short', '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00%D%x00%s%x00%B', full, '--'], top);
  const [oid, shortHash, parents, author, date, committer, commitDate, refs, subject, message] = out.split('\0');
  // diff-tree の --first-parent は親ごとの差分を制限しないため、比較する親を明示する
  const revisions = parents ? [parents.split(' ')[0], full] : ['--root', full];
  const names = (await git(['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', ...revisions, '--'], top)).split('\0');
  const files = [];
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++];
    const from = /^[RC]/.test(status) ? names[i++] : null;
    files.push({ code: status[0], status, from, path: names[i++] });
  }
  return { top, hash: oid, shortHash, parents: parents ? parents.split(' ') : [], author, date, committer, commitDate, refs, subject, message, files };
}

async function commitDiff(dir, hash, file) {
  validateHash(hash);
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('ファイルのパスを確認');
  const info = await commit(dir, hash);
  const changed = info.files.find((f) => f.path === file || f.from === file);
  if (!changed) throw new Error('このコミットで変わったファイルではありません');
  const revisions = info.parents.length ? [info.parents[0], info.hash] : ['--root', info.hash];
  const args = ['--literal-pathspecs', 'diff-tree', '-r', '-p', '-M', '--no-commit-id', '--no-color', '--no-ext-diff', '--no-textconv', ...revisions, '--'];
  if (changed.from) args.push(changed.from);
  args.push(changed.path);
  const out = await git(args, info.top);
  const lines = out.split('\n');
  const truncated = lines.length > DIFF_LINE_LIMIT;
  return { text: (truncated ? lines.slice(0, DIFF_LINE_LIMIT) : lines).join('\n'), truncated, binary: /^Binary files /m.test(out) };
}

module.exports = { log, commit, commitDiff };
