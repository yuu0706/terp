// エージェントの入力欄を画面の文字から探す（2026-10-30 利用者の指示。⌘A で入力欄だけを選ぶため）。
// 入力欄は各エージェントが文字で描いた枠にすぎず、terp からは位置を知る手段が無い。
// エージェントごとの見た目を決め打ちせず、入力中はカーソルが欄の中にあることを手がかりに、
// カーソルの行から上下へ、横線・枠の角・背景色の切れ目まで広げる。見つからなければ呼び出し側は画面全体の選択に戻す。
// 単体で試せるよう DOM と xterm に依存させない
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.terpInputBox = api;
})(globalThis, function () {
  // 入力の1行目の先頭の印（claude は ❯、codex は ›、ほかに > を使うものがある）
  const PROMPT = /^(\s*)[❯›>]\s/;
  // 枠の上下の線。角の付いた枠（╭─╮）も含む
  const RULE = /^\s*[╭╰┌└]?[─━]{3,}[╮╯┐┘]?\s*$/;
  // 枠の左右の縦線
  const SIDE = /^(\s*[│┃]\s?)(.*?)(\s?[│┃]\s*)?$/;
  // 枠を探して広げる行数の上限。これを超えたら入力欄ではないとみなす
  const MAX_ROWS = 40;

  const isRule = (text, cols) => RULE.test(text) && text.trim().length >= cols * 0.5;

  // 行 y が、カーソルの行から見て枠の外かどうか
  function isEdge(lines, y, cols, bg) {
    const line = lines[y];
    return isRule(line.text, cols) || line.bg !== bg;
  }

  function bounds(lines, cols, cursorRow) {
    const bg = lines[cursorRow].bg ?? null;
    let top = cursorRow;
    while (top > 0 && cursorRow - top < MAX_ROWS && !isEdge(lines, top - 1, cols, bg)) top--;
    let bottom = cursorRow;
    while (bottom < lines.length - 1 && bottom - cursorRow < MAX_ROWS && !isEdge(lines, bottom + 1, cols, bg)) bottom++;
    // 上下とも枠の外に当たって止まったときだけ入力欄とみなす（画面の端で止まったシェルなどを除く）
    if (top === 0 || bottom === lines.length - 1) return null;
    if (cursorRow - top >= MAX_ROWS || bottom - cursorRow >= MAX_ROWS) return null;
    return { top, bottom };
  }

  // 左右の縦線を除いた中身の位置。{ col: 中身の始まりの列, text: 中身 }
  function inner(text) {
    const side = text.match(SIDE);
    if (side && /[│┃]/.test(side[1])) return { col: side[1].length, text: side[2] };
    return { col: 0, text };
  }

  // lines は表示範囲の行（上から）。text は行の文字、bg は既定でない背景色（既定なら null）、
  // isDim(col) はその列の文字が薄い字なら true（空の入力欄に出る案内の文を除くため。無くてもよい）。
  // cursor は表示範囲の中のカーソルの位置 { row, col }。
  // 見つかれば、入力の文字の範囲（行と列）と、印と字下げを除いた文を返す
  function findInputBox(lines, cols, cursor) {
    if (!cursor || cursor.row < 0 || cursor.row >= lines.length) return null;
    const box = bounds(lines, cols, cursor.row);
    if (!box) return null;
    let start = -1;
    let indent = 0;
    for (let y = box.top; y <= box.bottom; y++) {
      const { col, text } = inner(lines[y].text);
      const prompt = text.match(PROMPT);
      if (prompt) { start = y; indent = col + prompt[0].length; break; }
    }
    // 印の無い枠は入力欄とみなさない。印より上にカーソルがあるときも同じ
    if (start < 0 || cursor.row < start) return null;
    const rows = [];
    for (let y = start; y <= box.bottom; y++) {
      const { col, text } = inner(lines[y].text);
      const full = (' '.repeat(col) + text).replace(/\s+$/, '');
      rows.push(full);
    }
    while (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
    const empty = { start: { row: start, col: indent }, end: { row: start, col: indent }, text: '' };
    // 空の入力欄に出る案内の文は、入力ではないため選ばない
    if (lines[start].isDim?.(indent)) return empty;
    // 続きの行は、1行目の文字の始まりまでの空白を字下げとして除く
    const body = rows.map((text, i) => (i === 0 ? text.slice(indent) : text.slice(Math.min(indent, text.length - text.trimStart().length))));
    if (body.every((text) => text === '')) return empty;
    const end = start + rows.length - 1;
    return {
      start: { row: start, col: indent },
      end: { row: end, col: Math.max(end === start ? indent : 0, rows[rows.length - 1].length) },
      text: body.join('\n'),
    };
  }

  return { findInputBox };
});
