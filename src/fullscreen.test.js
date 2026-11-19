// 閉じる前にフルスクリーンを抜けること（fullscreen.js）を確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { leaveFullScreenThen } = require('./fullscreen');

function fakeWindow(fullScreen) {
  const win = new EventEmitter();
  win.fullScreen = fullScreen;
  win.requests = [];
  win.isDestroyed = () => false;
  win.isFullScreen = () => win.fullScreen;
  win.setFullScreen = (value) => win.requests.push(value);
  return win;
}

test('フルスクリーンでなければ、すぐに閉じる', () => {
  const win = fakeWindow(false);
  let closed = 0;
  leaveFullScreenThen(win, () => closed++);
  assert.equal(closed, 1);
  assert.deepEqual(win.requests, []);
});

test('フルスクリーンなら、抜け終わってから閉じる', () => {
  const win = fakeWindow(true);
  let closed = 0;
  leaveFullScreenThen(win, () => closed++);
  assert.deepEqual(win.requests, [false]);
  assert.equal(closed, 0, '抜け終わる前には閉じない');
  win.emit('leave-full-screen');
  assert.equal(closed, 1);
});

test('抜け終わりの知らせが来なくても、待ちすぎずに一度だけ閉じる', async () => {
  const win = fakeWindow(true);
  let closed = 0;
  leaveFullScreenThen(win, () => closed++, 20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(closed, 1);
  win.emit('leave-full-screen');
  assert.equal(closed, 1, '後から知らせが来ても二度は閉じない');
});

test('窓が無ければ、そのまま閉じる', () => {
  let closed = 0;
  leaveFullScreenThen(null, () => closed++);
  assert.equal(closed, 1);
});
