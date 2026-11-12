const test = require('node:test');
const assert = require('node:assert/strict');
const { findInputBox } = require('./inputbox');

const COLS = 40;
const rule = '─'.repeat(COLS);
const plain = (texts) => texts.map((text) => ({ text, bg: null }));

test('claude の入力欄は2本の線の間で、印と字下げを除く', () => {
  const lines = plain(['hello', rule, '  過去の線の下', 'ctrl+g to edit', rule, '❯ first line', '  second line', '', rule, '  status line']);
  assert.deepEqual(findInputBox(lines, COLS, { row: 7, col: 2 }), {
    start: { row: 5, col: 2 },
    end: { row: 6, col: 13 },
    text: 'first line\nsecond line',
  });
});

test('codex の入力欄は背景色の付いたかたまりで、› の行から始まる', () => {
  const lines = [
    { text: 'output', bg: null },
    { text: '', bg: 7 },
    { text: '› first line', bg: 7 },
    { text: '  second line', bg: 7 },
    { text: '', bg: 7 },
    { text: '  agents: 0', bg: null },
  ];
  assert.deepEqual(findInputBox(lines, COLS, { row: 4, col: 2 }), {
    start: { row: 2, col: 2 },
    end: { row: 3, col: 13 },
    text: 'first line\nsecond line',
  });
});

test('角の丸い枠と左右の縦線の中も探せる', () => {
  const lines = plain(['output', `╭${'─'.repeat(COLS - 2)}╮`, '│ > hello world                        │', '│   next                               │', `╰${'─'.repeat(COLS - 2)}╯`, 'footer']);
  const box = findInputBox(lines, COLS, { row: 2, col: 10 });
  assert.equal(box.text, 'hello world\nnext');
  assert.deepEqual(box.start, { row: 2, col: 4 });
  assert.deepEqual(box.end, { row: 3, col: 8 });
});

test('空の入力欄は空の範囲を返し、薄い案内の文は選ばない', () => {
  assert.equal(findInputBox(plain([rule, '❯ ', rule]), COLS, { row: 1, col: 2 }).text, '');
  const lines = plain([rule, '❯ Try "fix lint errors"', rule]);
  lines[1].isDim = (col) => col >= 2;
  assert.deepEqual(findInputBox(lines, COLS, { row: 1, col: 2 }), { start: { row: 1, col: 2 }, end: { row: 1, col: 2 }, text: '' });
});

test('入力欄でない画面では見つからない', () => {
  // シェルの画面は上下が枠で閉じていない
  assert.equal(findInputBox(plain(['% ls', 'a b c', '> ']), COLS, { row: 2, col: 2 }), null);
  // 枠はあるが印が無い（確認の選択肢など）
  assert.equal(findInputBox(plain([rule, 'Do you want to proceed?', rule]), COLS, { row: 1, col: 0 }), null);
  // カーソルが枠の外にある
  assert.equal(findInputBox(plain(['out', rule, '❯ x', rule, 'status']), COLS, { row: 4, col: 0 }), null);
  // 短い線は枠とみなさない
  assert.equal(findInputBox(plain(['─────', '❯ x', '─────']), COLS, { row: 1, col: 2 }), null);
});
