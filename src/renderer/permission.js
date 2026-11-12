// 並べて動かすエージェントの見張り。許可の画面を画面の文字から読むことと、同じファイルの書き換えの重なりを探すこと。
// DOM と時計を参照しないため、自己診断から直接確かめられる

const RULE = /^\s*[╭┌├]?[─━═]{3,}/;
const OPTION = /^\s*([❯›>])?\s*(\d)\.\s+(.+?)\s*$/;

// claude の許可の画面（「Do you want …?」の下に番号付きの選択肢が並び、❯ が今の選び）を読む。
// 選択肢が2つ以上あり、❯ の位置が分かるときだけ返す。選択肢の折り返しは前の選択肢に足す
export function parsePermission(text) {
  const raw = String(text || '').split('\n');
  const lines = raw.map((line) => line.replace(/[│┃]/g, ' ').replace(/\s+$/, ''));
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/do you want|would you like|しますか/i.test(lines[i]) && /\?|？/.test(lines[i])) { q = i; break; }
  }
  if (q < 0) return null;
  const options = [];
  let cursor = -1;
  let pending = [];
  for (let i = q + 1; i < lines.length && i <= q + 16; i++) {
    const m = lines[i].match(OPTION);
    if (m && Number(m[2]) === options.length + 1) {
      if (options.length && pending.length) options[options.length - 1] += ' ' + pending.join(' ');
      pending = [];
      if (m[1]) cursor = options.length;
      options.push(m[3]);
    } else if (options.length && lines[i].trim()) pending.push(lines[i].trim());
    else if (options.length && !lines[i].trim()) pending = [];
  }
  if (options.length < 2 || cursor < 0) return null;
  // 何を許可するかは、問いの上から区切りの線（または10行）までの文字
  let top = q - 1;
  while (top >= 0 && q - top <= 10 && !RULE.test(raw[top])) top--;
  const detail = lines.slice(top + 1, q).map((line) => line.trim()).filter(Boolean).slice(0, 6);
  return { question: lines[q].trim(), detail, options, cursor };
}

// 同じ許可の画面かどうか（押す直前に読み直して、変わっていたら送らない）
export function permissionSignature(prompt) {
  return prompt ? JSON.stringify([prompt.question, prompt.detail, prompt.options]) : '';
}

// 今の選び（cursor）から target まで矢印で動かして Enter。番号のキーの扱いは版で違うため使わない
export function permissionKeys(cursor, target) {
  const step = target > cursor ? '\x1b[B' : '\x1b[A';
  return step.repeat(Math.abs(target - cursor)) + '\r';
}

// エージェントごとの最近の編集（{ id, edits: [{ path, at }] }）から、同じファイルを書き換えた組を探す。
// within ミリ秒より前の編集と、時刻の分からない編集は数えない。返すのは id ごとの [{ path, others: [id] }]
export function findClashes(agents, now, within = 30 * 60 * 1000) {
  const byPath = new Map();
  for (const agent of agents) {
    for (const edit of agent.edits || []) {
      if (!(edit.at > 0) || now - edit.at > within) continue;
      if (!byPath.has(edit.path)) byPath.set(edit.path, new Set());
      byPath.get(edit.path).add(agent.id);
    }
  }
  const result = new Map();
  for (const [file, ids] of byPath) {
    if (ids.size < 2) continue;
    for (const id of ids) {
      if (!result.has(id)) result.set(id, []);
      result.get(id).push({ path: file, others: [...ids].filter((other) => other !== id) });
    }
  }
  return result;
}

// ⌘M のタイルの並びの重み。許可待ち・終わった（未確認）を先に、考え中、それ以外の順
export function urgencyRank(state) {
  return ({ waiting: 0, done: 1, notify: 1, working: 2, busy: 2, unread: 2 })[state] ?? 3;
}
