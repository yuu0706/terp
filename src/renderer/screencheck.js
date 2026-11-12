// 端末の表示の崩れを、画面の文字と大きさから見つける。
// claude などの入力欄は罫線の枠（╭─╮ / ╰─╯）で描かれ、描き直すたびに前の枠を消してから描く。
// 大きさが変わったときなどに消し損ねると、枠が重なったり、枠の切れ端（─ だけの行など）が残ったりする
const TOP = /[╭┌]─+[╮┐]/;
const BOTTOM = /[╰└]─+[╯┘]/;
const RULE = /─{4,}/;

// lines は表示範囲の行（右の空白は除いたもの）。size は端末の桁と行、pty はシェルに伝えた桁と行
export function checkScreen({ lines, size, pty, cursor }) {
  const issues = [];
  const tops = lines.filter((line) => TOP.test(line)).length;
  const bottoms = lines.filter((line) => BOTTOM.test(line)).length;
  // 罫線があるのに枠の上端・下端・区切り（行の端から端まで）のどれでもない行は、消し損ねた切れ端とみなす
  const fragments = lines.filter((line) => RULE.test(line) && !TOP.test(line) && !BOTTOM.test(line)
    && !(size && line.trim().length >= size.cols - 2 && /^[\s─━═]+$/.test(line))).length;
  if (tops > 1 || bottoms > 1) issues.push({ kind: 'duplicate-box', message: `入力欄の枠が ${Math.max(tops, bottoms)} つ重なっている` });
  if (tops !== bottoms) issues.push({ kind: 'broken-box', message: `枠の上端 ${tops} と下端 ${bottoms} の数が合わない` });
  if (fragments) issues.push({ kind: 'fragments', message: `罫線の切れ端が ${fragments} 行残っている` });
  if (size && pty && (size.cols !== pty.cols || size.rows !== pty.rows)) {
    issues.push({ kind: 'size-mismatch', message: `画面は ${size.cols}×${size.rows}、シェルに伝えた大きさは ${pty.cols}×${pty.rows}` });
  }
  if (size && cursor && (cursor.y < 0 || cursor.y >= size.rows || cursor.x < 0 || cursor.x > size.cols)) {
    issues.push({ kind: 'cursor', message: `カーソルが画面の外（${cursor.x}, ${cursor.y}）にある` });
  }
  return { ok: issues.length === 0, issues, tops, bottoms, fragments };
}
