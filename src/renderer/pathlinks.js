// URL は先に読み飛ばし、パスの区切りと行・桁を1回の走査で読む。
const PATH_TOKEN = /https?:\/\/[^\s"'`<>\[\]{}「」『』【】]+|((?:(?!https?:\/\/)[^\s"'`<>\[\]{}():,;=「」『』【】（）。，])+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)| line (\d+))?/gu;
const CACHE_MS = 5000;
const stats = new Map();

export function findPaths(text) {
  const found = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    if (!m[1]) continue;
    let path = m[1];
    while (path.endsWith('.')) path = path.slice(0, -1);
    const dot = path.lastIndexOf('.');
    if (!path || (!path.includes('/') && !(dot > 0 && dot < path.length - 1))) continue;
    // ./ や ../ や / だけ（今いる場所そのものなど）はよく出るため、リンクにしない
    if (/^(?:\.{1,2}\/?|\/|~\/?)$/.test(path)) continue;
    const line = m[2] || m[4] || m[6];
    const column = m[3] || m[5];
    const end = m.index + (line ? m[0].length : path.length);
    found.push({ text: text.slice(m.index, end), start: m.index, end, path,
      line: line ? Number(line) : undefined, column: column ? Number(column) : undefined });
  }
  return found;
}

function absolutePath(path, base) {
  const parts = [];
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return '/' + parts.join('/');
}

function cachedStat(path, statFile) {
  const now = Date.now();
  const previous = stats.get(path);
  if (previous && previous.until > now) return previous.result;
  for (const [key, entry] of stats) if (entry.until <= now) stats.delete(key);
  if (stats.size >= 1024) stats.delete(stats.keys().next().value);
  const entry = { until: Infinity, result: null };
  entry.result = Promise.resolve().then(() => statFile(path)).catch(() => null).then((res) => {
    entry.until = Date.now() + CACHE_MS;
    return res?.ok && res.value.exists && (res.value.file || (res.value.mode & 0o170000) === 0o040000) ? res.value : null;
  });
  stats.set(path, entry);
  return entry.result;
}

function logicalLine(term, row) {
  const buffer = term.buffer.active;
  if (!buffer.getLine(row)) return null;
  let first = row;
  while (first > 0 && buffer.getLine(first).isWrapped) first--;
  let last = row;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const starts = [];
  const ends = [];
  const cell = buffer.getNullCell();
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    let content = '';
    for (let x = 0; x < Math.min(term.cols, line.length); x++) {
      line.getCell(x, cell);
      const width = cell.getWidth();
      if (!width) continue;
      // 全角文字が次の行へ送られたときの、右端の空セルはパスに含めない。
      if (y < last && x === term.cols - 1 && !cell.getCode()) continue;
      const chars = cell.getChars() || ' ';
      content += chars;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ x: x + 1, y: y + 1 });
        ends.push({ x: x + width, y: y + 1 });
      }
    }
    text += y === last ? content.trimEnd() : content;
  }
  return { buffer, cols: term.cols, first, last, text, starts, ends };
}

export function createPathLinkProvider(term, { context, statFile, openFile, revealFile, onHover }) {
  const parsed = new Map();

  async function resolve(candidate, { cwd, root, home }) {
    const path = candidate.path.startsWith('~/') ? home + candidate.path.slice(1) : candidate.path;
    const bases = path.startsWith('/') ? [''] : [...new Set([cwd, root].filter(Boolean))];
    for (const base of bases) {
      const full = absolutePath(path, base);
      const stat = await cachedStat(full, statFile);
      if (stat) return { ...candidate, path: full, directory: !stat.file };
    }
    return null;
  }

  async function linksForLine(row) {
    const logical = logicalLine(term, row - 1);
    if (!logical) return [];
    const location = context();
    let candidates = parsed.get(logical.text);
    if (!candidates) {
      candidates = findPaths(logical.text);
      if (parsed.size >= 256) parsed.delete(parsed.keys().next().value);
      parsed.set(logical.text, candidates);
    }
    const resolved = await Promise.all(candidates.map((candidate) => resolve(candidate, location)));
    const current = logicalLine(term, row - 1);
    const nextLocation = context();
    // IPC を待つ間の出力・スクロール・移動に、古い座標のリンクを残さない。
    if (!current || current.buffer !== logical.buffer || current.first !== logical.first || current.text !== logical.text ||
        term.cols !== logical.cols ||
        location.cwd !== nextLocation.cwd || location.root !== nextLocation.root) return [];
    return resolved.filter(Boolean).map((link) => {
      const open = () => link.directory ? revealFile(link.path) : openFile(link.path, { line: link.line, column: link.column });
      return {
        ...link,
        range: { start: logical.starts[link.start], end: logical.ends[link.end - 1] },
        decorations: { underline: true, pointerCursor: true },
        open,
        // 普通のクリックは文字の選択に使うため開かない。⌘クリックで開き、右クリックは onHover で受けた先が開く
        activate: (event) => { if (event?.metaKey) open(); },
        hover: () => onHover?.(open),
        leave: () => onHover?.(null),
      };
    });
  }

  async function visibleLinks() {
    const buffer = term.buffer.active;
    const first = buffer.viewportY;
    const last = Math.min(buffer.length, first + term.rows);
    const links = [];
    for (let row = first; row < last;) {
      const logical = logicalLine(term, row);
      links.push(...(await linksForLine(row + 1)).filter((link) => link.range.start.y <= last && link.range.end.y > first));
      row = logical.last + 1;
    }
    return links;
  }

  return {
    provideLinks(row, callback) {
      linksForLine(row).then((links) => callback(links.filter((link) => link.range.start.y <= row && link.range.end.y >= row)), () => callback([]));
    },
    linksForLine,
    visibleLinks,
    async activate(text) {
      const link = (await visibleLinks()).find((item) => item.text === text);
      if (!link) return false;
      await link.open();
      return true;
    },
  };
}
