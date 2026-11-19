// フルスクリーンのまま窓を閉じると、macOS が全画面の Space を片付けきれず、空の画面が残る（2026-11-18 利用者の指摘）。
// 閉じる前にフルスクリーンを抜け、抜け終わってから閉じる。抜け終わりの知らせが来なければ、待ちすぎないよう timeoutMs で閉じる。
// 抜ける動きを見せずに閉じる手段は見つかっていないため、窓が元の大きさへ戻る動きが見えてから終わる
function leaveFullScreenThen(win, then, timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.isFullScreen()) {
    then();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    win.removeListener('leave-full-screen', finish);
    then();
  };
  const timer = setTimeout(finish, timeoutMs);
  win.once('leave-full-screen', finish);
  win.setFullScreen(false);
}

module.exports = { leaveFullScreenThen };
