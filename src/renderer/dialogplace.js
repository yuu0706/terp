// 確認などのダイアログを、開くきっかけになったボタンのそばに出す（2026-10-30 利用者の指示。カーソルの移動を減らすため）。
// 各ダイアログに呼び出し元を渡す代わりに、直前に押した要素を覚えておき、開いた直後に置き直す。
// キーで開いたとき・押してから時間が経って開いたときは、これまでどおり画面の中央に出す
const RECENT_MS = 1500;
const GAP = 8;
const MARGIN = 16;

export function initDialogPlacement(root = document) {
  let last = null;
  const watching = new Map();

  root.addEventListener('click', (event) => {
    const el = event.target.closest?.('button, [role="button"], [role="menuitem"], a, input, label');
    if (!el || el.closest('dialog')?.dataset.placement === 'center') return;
    // 載せたときだけ出るボタンは、ダイアログの背景が重なると隠れる。メニューの項目も押すと消える。
    // そのため位置は押したときに控え、大きさの無い要素なら見えている親の位置を使う
    let box = el;
    while (box && box !== document.body && !box.getBoundingClientRect().width) box = box.parentElement;
    last = { rect: box.getBoundingClientRect(), at: performance.now() };
  }, true);

  const place = (dialog, rect) => {
    const size = dialog.getBoundingClientRect();
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - size.height;
    let top = below + size.height <= window.innerHeight - MARGIN ? below
      : above >= MARGIN ? above
        : window.innerHeight - MARGIN - size.height;
    top = Math.max(MARGIN, top);
    const center = rect.left + rect.width / 2 - size.width / 2;
    const left = Math.min(Math.max(MARGIN, center), window.innerWidth - MARGIN - size.width);
    dialog.style.margin = '0';
    dialog.style.top = `${Math.round(top)}px`;
    dialog.style.left = `${Math.round(Math.max(MARGIN, left))}px`;
  };

  const release = (dialog) => {
    watching.get(dialog)?.disconnect();
    watching.delete(dialog);
    dialog.style.removeProperty('margin');
    dialog.style.removeProperty('top');
    dialog.style.removeProperty('left');
    delete dialog.dataset.placedNear;
  };

  // dialog の toggle は泡立たないため、捕捉の段階で受ける
  root.addEventListener('toggle', (event) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement)) return;
    if (event.newState !== 'open') { release(dialog); return; }
    const anchor = last;
    last = null;
    if (!anchor || dialog.dataset.placement === 'center' || performance.now() - anchor.at > RECENT_MS) return;
    const { rect } = anchor;
    if (!rect.width && !rect.height) return;
    place(dialog, rect);
    dialog.dataset.placedNear = 'true';
    // エラーの文が出るなどで背が伸びたら、窓の外へはみ出さないよう置き直す
    const observer = new ResizeObserver(() => { if (dialog.open) place(dialog, rect); });
    observer.observe(dialog);
    watching.set(dialog, observer);
  }, true);
}
