// 常駐のプロセスが出力の末尾だけを残すときに、捨てた出力の中の画面の切り替え（DEC の private mode）を覚えておく。
// claude などは最初に全画面表示（?1049h）やマウスの受け取りへ切り替え、後は差分だけを送る。
// 切り替えが捨てた側に入ると、流し直したときに普通の画面へ差分だけが描かれ、画面が崩れる（2026-10-29 利用者の指摘）
const MODE = /\x1b\[\?([\d;]+)([hl])/g;
// 同期出力（?2026）は描く間だけの合図のため、覚えない
const TRANSIENT = new Set(['2026']);
// 捨てる出力の切れ目にまたがった合図も拾うため、前の出力の末尾をこれだけ持ち越す
const CARRY = 32;

function createModeTracker() {
  const modes = new Map();
  let carry = '';
  return {
    // 捨てる出力を古い順に渡す
    drop(data) {
      const text = carry + data;
      for (const m of text.matchAll(MODE)) {
        for (const n of m[1].split(';')) {
          if (!n || TRANSIENT.has(n)) continue;
          modes.delete(n);
          modes.set(n, m[2]);
        }
      }
      carry = text.slice(-CARRY);
    },
    // 流し直す出力の前に付ける、捨てた出力の時点の切り替え
    prefix() {
      return [...modes].map(([n, v]) => `\x1b[?${n}${v}`).join('');
    },
  };
}

module.exports = { createModeTracker };
