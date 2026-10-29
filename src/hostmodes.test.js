// 常駐のプロセスが捨てた出力の中の画面の切り替えを覚えること（hostmodes.js）を確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModeTracker } = require('./hostmodes');

test('捨てた出力の全画面表示とマウスの切り替えを、流し直す前に付ける', () => {
  const t = createModeTracker();
  t.drop('起動\x1b[?1049h\x1b[?1000h\x1b[?1006h画面');
  assert.equal(t.prefix(), '\x1b[?1049h\x1b[?1000h\x1b[?1006h');
});

test('同じ切り替えは最後の値だけを残す', () => {
  const t = createModeTracker();
  t.drop('\x1b[?1049h\x1b[?25l');
  t.drop('\x1b[?1049l\x1b[?25h');
  assert.equal(t.prefix(), '\x1b[?1049l\x1b[?25h');
});

test('まとめて書いた切り替えも1つずつ覚える', () => {
  const t = createModeTracker();
  t.drop('\x1b[?1000;1006h');
  assert.equal(t.prefix(), '\x1b[?1000h\x1b[?1006h');
});

test('捨てる出力の切れ目にまたがった切り替えも拾う', () => {
  const t = createModeTracker();
  t.drop('前の出力\x1b[?10');
  t.drop('49h後の出力');
  assert.equal(t.prefix(), '\x1b[?1049h');
});

test('同期出力の合図は覚えない', () => {
  const t = createModeTracker();
  t.drop('\x1b[?2026h描く\x1b[?2026l');
  assert.equal(t.prefix(), '');
});

test('何も捨てていなければ何も付けない', () => {
  assert.equal(createModeTracker().prefix(), '');
});
