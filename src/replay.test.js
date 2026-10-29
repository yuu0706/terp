// 開き直したときの流し直しの段取り（renderer/replay.js）と、表示の崩れの見つけ方（renderer/screencheck.js）を確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 画面側の部品は ES モジュールのため、ほかの試験と同じく data: の URL で読み込む
const load = (name) => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, 'renderer', name)).toString('base64'));

test('大きさを伝えた位置で区切って流し直す', async () => {
  const { appendTail, recordSize, planReplay, MARK_LENGTH } = await load('replay.js');
  let log = recordSize([], '', 80, 24);
  let tail = appendTail('', 'first frame at 80;');
  log = recordSize(log, tail, 100, 30);
  tail = appendTail(tail, 'second frame at 100;');
  log = recordSize(log, tail, 90, 30);
  const replay = 'first frame at 80;second frame at 100;third frame at 90';
  assert.deepEqual(planReplay(replay, log), {
    segments: [
      { text: 'first frame at 80;', cols: 80, rows: 24 },
      { text: 'second frame at 100;', cols: 100, rows: 30 },
      { text: 'third frame at 90', cols: 90, rows: 30 },
    ],
    final: { cols: 90, rows: 30 },
  });
  // 残っている出力より前に伝えた大きさは、流し始めの大きさになる
  assert.deepEqual(planReplay('second frame at 100;third', log).segments.map((s) => [s.text, s.cols]), [['second frame at 100;', 100], ['third', 90]]);
  // 記録が無ければ null（呼ぶ側がまとめて流す）
  assert.equal(planReplay('abc', []), null);
  // 末尾は MARK_LENGTH までに切る
  assert.equal(appendTail('', 'x'.repeat(MARK_LENGTH + 10)).length, MARK_LENGTH);
});

test('位置が分からなくなった後は、最後に一度だけ大きさを合わせる', async () => {
  const { recordSize, planReplay } = await load('replay.js');
  let log = recordSize([], '', 80, 24);
  log = recordSize(log, 'AAA', 100, 30);
  log = recordSize(log, 'missing', 70, 20);
  log = recordSize(log, 'BBB', 60, 20);
  const plan = planReplay('xxAAAyyBBBzz', log);
  assert.deepEqual(plan.segments.map((s) => [s.text, s.cols]), [['xxAAA', 80], ['yyBBBzz', 100]]);
  assert.deepEqual(plan.final, { cols: 60, rows: 20 });
});

test('入力欄の枠の重なり・切れ端・大きさの食い違いを見つける', async () => {
  const { checkScreen } = await load('screencheck.js');
  const box = ['╭────────╮', '│ >      │', '╰────────╯'];
  assert.equal(checkScreen({ lines: ['hello', ...box], size: { cols: 10, rows: 4 }, pty: { cols: 10, rows: 4 }, cursor: { x: 3, y: 2 } }).ok, true);
  const doubled = checkScreen({ lines: [...box, ...box], size: { cols: 10, rows: 6 }, pty: { cols: 10, rows: 6 }, cursor: { x: 0, y: 0 } });
  assert.deepEqual(doubled.issues.map((i) => i.kind), ['duplicate-box']);
  const broken = checkScreen({ lines: ['╭──────', '──╮', ...box], size: { cols: 8, rows: 5 }, pty: { cols: 9, rows: 5 }, cursor: { x: 0, y: 0 } });
  assert.deepEqual(broken.issues.map((i) => i.kind), ['fragments', 'size-mismatch']);
  // 行の端から端までの区切りの線は切れ端に数えない
  assert.equal(checkScreen({ lines: ['─'.repeat(10), 'text'], size: { cols: 10, rows: 2 } }).fragments, 0);
});
