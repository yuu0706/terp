// 開き直したときに、常駐のプロセスに残った出力を画面へ流し直す段取り。
// 出力は、そのときシェルに伝えていた大きさで中のプログラムが描いたもの。今の大きさでまとめて流すと、
// 大きさを変える前に描いた claude などの画面が全部折り返して崩れる。
// そこで、シェルに大きさを伝えるたびに「そこまでに受け取った出力の末尾」と大きさを控えておき、
// 流し直すときは、その末尾が現れた位置で同じ順に大きさを変えながら流す（生きている画面が見たのと同じ順になる）
export const MARK_LENGTH = 512;
export const MAX_SIZES = 30;

export function appendTail(tail, data) {
  const next = tail + data;
  return next.length > MARK_LENGTH ? next.slice(-MARK_LENGTH) : next;
}

// 大きさを伝えた記録に1件足す。mark が空のものは、出力が始まる前（ターミナルを作ったとき）の大きさ
export function recordSize(log, tail, cols, rows) {
  return [...(Array.isArray(log) ? log : []), { mark: tail, cols, rows }].slice(-MAX_SIZES);
}

// 末尾（mark）が現れる位置のうち、終わりが前の区切り（pos）より後ろにあるもの。末尾は前の区切りより前から始まることがある
function findMark(text, mark, pos) {
  let at = text.indexOf(mark, Math.max(0, pos - mark.length));
  while (at >= 0 && at + mark.length < pos) at = text.indexOf(mark, at + 1);
  return at;
}

// 残っている出力の先頭が、末尾（mark）の途中から始まっているときの、その末尾の終わりの位置。
// 常駐のプロセスは出力の末尾しか残さないため、区切りが先頭の近くにあると mark の前半が欠ける。短すぎる一致は偶然とみなす
const MIN_PARTIAL = 16;
function findCutAtStart(text, mark) {
  for (let k = Math.min(mark.length - 1, text.length); k >= MIN_PARTIAL; k--) {
    if (mark.endsWith(text.slice(0, k))) return k;
  }
  return -1;
}

// 流し直す出力を、大きさごとの区切りに分ける。返す区切りは古い順で、各区切りはその大きさにしてから流す。
// 末尾が見つからない記録は、残っている出力より前の出来事とみなす。見つかった後に見つからない記録が出たら、
// 位置が分からないため、そこから先は最後に一度だけ大きさを合わせる
export function planReplay(replay, log) {
  const entries = (Array.isArray(log) ? log : []).filter((e) => e && Number.isInteger(e.cols) && Number.isInteger(e.rows));
  if (!entries.length) return null;
  let start = entries[0];
  const cuts = [];
  let pos = 0;
  let lost = false;
  for (const entry of entries) {
    if (lost) continue;
    const at = entry.mark ? findMark(replay, entry.mark, pos) : -1;
    const end = at >= 0 ? at + entry.mark.length : !cuts.length && entry.mark ? findCutAtStart(replay, entry.mark) : -1;
    if (end < 0) {
      if (cuts.length) lost = true;
      else start = entry;
      continue;
    }
    pos = end;
    cuts.push({ at: pos, cols: entry.cols, rows: entry.rows });
  }
  const segments = [];
  let from = 0;
  let size = { cols: start.cols, rows: start.rows };
  for (const cut of cuts) {
    segments.push({ text: replay.slice(from, cut.at), ...size });
    from = cut.at;
    size = { cols: cut.cols, rows: cut.rows };
  }
  segments.push({ text: replay.slice(from), ...size });
  const last = entries[entries.length - 1];
  return { segments: segments.filter((seg, i) => seg.text || i === segments.length - 1), final: { cols: last.cols, rows: last.rows } };
}
