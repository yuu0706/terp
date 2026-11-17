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
      line: line ? Number(line) : undefined, column: column ? Number(column) : undefined,
      shorter: shorterPaths(m.index, path) });
  }
  return found;
}

// 「app.jsを直した」のように、パスの直後に日本語が続くと区切れない。
// 日本語の名前のファイルもあるため日本語は外さずに読み、そのパスが無いときに試す短い候補（英数字から日本語へ変わる手前まで）を長い順に返す。
function shorterPaths(start, path) {
  const result = [];
  for (let i = path.length - 1; i > 0; i--) {
    if (path.charCodeAt(i - 1) > 0x7f || path.charCodeAt(i) <= 0x7f) continue;
    let cut = path.slice(0, i);
    while (cut.endsWith('.')) cut = cut.slice(0, -1);
    const dot = cut.lastIndexOf('.');
    // 「/tmp/日本語」の「/tmp/」のように、日本語の名前の手前のフォルダーまでで切ったものは、別の場所を指すため試さない
    if (cut.endsWith('/') || (!cut.includes('/') && !(dot > 0 && dot < cut.length - 1))) continue;
    result.push({ text: cut, start, end: start + cut.length, path: cut, line: undefined, column: undefined });
  }
  return result;
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

// 改行をまたいで探すときに、上下それぞれ何行まで見るか
const JOIN_LINES = 3;

// 行を区画に分ける。罫線（│ か |）のある1行は罫線ごとのセル、それ以外は行の全体とし、前後の空白を除く。
function segmentsOf(logical) {
  const { text, starts } = logical;
  const borders = [];
  if (logical.first === logical.last) for (let i = 0; i < text.length; i++) if (text[i] === '│' || text[i] === '|') borders.push(i);
  const cuts = [-1, ...borders, text.length];
  const segments = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    let from = cuts[k] + 1;
    let to = cuts[k + 1];
    while (from < to && text[from] === ' ') from++;
    while (to > from && text[to - 1] === ' ') to--;
    segments.push({ from, to });
  }
  return { borders: borders.map((i) => starts[i].x).join(','), segments };
}

function joinable(upper, lower) {
  return upper && lower && upper.to > upper.from && lower.to > lower.from;
}

export function createPathLinkProvider(term, { context, statFile, openFile, revealFile, onHover }) {
  const parsed = new Map();

  async function resolve({ shorter = [], ...candidate }, { cwd, root, home }) {
    for (const option of [candidate, ...shorter]) {
      const path = option.path.startsWith('~/') ? home + option.path.slice(1) : option.path;
      const bases = path.startsWith('/') ? [''] : [...new Set([cwd, root].filter(Boolean))];
      for (const base of bases) {
        const full = absolutePath(path, base);
        const stat = await cachedStat(full, statFile);
        if (stat) return { ...option, path: full, directory: !stat.file };
      }
    }
    return null;
  }

  function parse(text) {
    let candidates = parsed.get(text);
    if (!candidates) {
      candidates = findPaths(text);
      if (parsed.size >= 256) parsed.delete(parsed.keys().next().value);
      parsed.set(text, candidates);
    }
    return candidates;
  }

  function toLink(link, range) {
    const open = () => link.directory ? revealFile(link.path) : openFile(link.path, { line: link.line, column: link.column });
    return {
      ...link,
      range,
      decorations: { underline: true, pointerCursor: true },
      open,
      // 普通のクリックは文字の選択に使うため開かない。⌘クリックで開き、右クリックは onHover で受けた先が開く
      activate: (event) => { if (event?.metaKey) open(); },
      hover: () => onHover?.(open),
      leave: () => onHover?.(null),
    };
  }

  // claude などは枠の幅で自分で改行するため、端末の折り返しの印が付かない。
  // 上下の行の同じ区画（表なら同じ桁のセル、それ以外は字下げを除いた行）をつなぎ、改行をまたぐパスを探す。
  async function joinedLinks(lines, index, location) {
    const layouts = lines.map(segmentsOf);
    const current = layouts[index];
    const links = [];
    for (let k = 0; k < current.segments.length; k++) {
      let top = index;
      while (top > 0 && layouts[top - 1].borders === current.borders && joinable(layouts[top - 1].segments[k], layouts[top].segments[k])) top--;
      let bottom = index;
      while (bottom < lines.length - 1 && layouts[bottom + 1].borders === current.borders && joinable(layouts[bottom].segments[k], layouts[bottom + 1].segments[k])) bottom++;
      if (top === bottom) continue;
      const pieces = [];
      let text = '';
      for (let i = top; i <= bottom; i++) {
        const { from, to } = layouts[i].segments[k];
        pieces.push({ line: i, from, to, offset: text.length });
        text += lines[i].text.slice(from, to);
      }
      const pieceAt = (position) => pieces.findLastIndex((piece) => piece.offset <= position);
      const crossing = parse(text).filter((candidate) => pieceAt(candidate.start) < pieceAt(candidate.end - 1));
      const resolved = await Promise.all(crossing.map((candidate) => resolve(candidate, location)));
      for (const link of resolved) {
        if (!link) continue;
        const first = pieceAt(link.start);
        const last = pieceAt(link.end - 1);
        // 日本語を外して縮めた結果、改行をまたがなくなったものは、行ごとの探し方に任せる
        if (first === last) continue;
        const piece = pieces.find((item) => item.line === index);
        const p = pieces.indexOf(piece);
        if (p < first || p > last) continue;
        const end = p < pieces.length - 1 ? pieces[p + 1].offset : text.length;
        const from = Math.max(link.start, piece.offset) - piece.offset + piece.from;
        const to = Math.min(link.end, end) - piece.offset + piece.from;
        const logical = lines[index];
        links.push({ ...link, text: text.slice(link.start, link.end), from, to,
          range: { start: logical.starts[from], end: logical.ends[to - 1] } });
      }
    }
    return links;
  }

  function surroundings(row) {
    const center = logicalLine(term, row);
    if (!center) return null;
    const lines = [center];
    while (lines.length <= JOIN_LINES && lines[0].first > 0) lines.unshift(logicalLine(term, lines[0].first - 1));
    const index = lines.length - 1;
    for (let n = 0; n < JOIN_LINES; n++) {
      const next = logicalLine(term, lines.at(-1).last + 1);
      if (!next) break;
      lines.push(next);
    }
    return { lines, index, key: lines.map((line) => `${line.first}:${line.text}`).join('\n') };
  }

  async function linksForLine(row) {
    const around = surroundings(row - 1);
    if (!around) return [];
    const logical = around.lines[around.index];
    const location = context();
    const [resolved, joined] = await Promise.all([
      Promise.all(parse(logical.text).map((candidate) => resolve(candidate, location))),
      joinedLinks(around.lines, around.index, location),
    ]);
    const now = surroundings(row - 1);
    const nextLocation = context();
    // IPC を待つ間の出力・スクロール・移動に、古い座標のリンクを残さない。
    if (!now || now.lines[now.index].buffer !== logical.buffer || now.key !== around.key ||
        term.cols !== logical.cols ||
        location.cwd !== nextLocation.cwd || location.root !== nextLocation.root) return [];
    // 改行をまたいで見つかったパスと重なる、行の中だけの切れ端は出さない
    const single = resolved.filter((link) => link && !joined.some((item) => link.start < item.to && item.from < link.end));
    return [
      ...single.map((link) => toLink(link, { start: logical.starts[link.start], end: logical.ends[link.end - 1] })),
      ...joined.map(({ from, to, range, ...link }) => toLink(link, range)),
    ];
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
