// アイコンだけのボタンの説明を、カーソルを1秒重ねたらチップで出す（2026-10-29 利用者の指示）。
// OS の title の吹き出しは出るまでの時間と見た目を選べないため、重ねている間だけ title を外して自前のチップを出す
const TARGET = '.icon-btn, .btn--agent';
const DELAY_MS = 1000;
const GAP = 6;

export function initTooltips(root = document) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let current = null;
  let timer = null;

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    tip.hidden = true;
    if (!current) return;
    // 重ねている間にほかの処理が title を付け直していれば、そちらを残す
    if (!current.hasAttribute('title') && current.dataset.tooltip) current.setAttribute('title', current.dataset.tooltip);
    delete current.dataset.tooltip;
    current = null;
  };

  const show = () => {
    if (!current?.isConnected) { hide(); return; }
    tip.textContent = current.dataset.tooltip;
    tip.hidden = false;
    const box = current.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    // ボタンの下に出し、窓の下にはみ出すなら上に出す。左右は窓の中に収める
    let top = box.bottom + GAP;
    if (top + size.height > window.innerHeight - GAP) top = box.top - size.height - GAP;
    const left = Math.min(Math.max(GAP, box.left + box.width / 2 - size.width / 2), window.innerWidth - size.width - GAP);
    tip.style.top = `${Math.max(GAP, top)}px`;
    tip.style.left = `${left}px`;
  };

  root.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.(TARGET);
    if (target === current) return;
    hide();
    const text = target?.getAttribute('title') || target?.getAttribute('aria-label');
    if (!target || !text || target.disabled) return;
    current = target;
    current.dataset.tooltip = text;
    current.removeAttribute('title');
    timer = setTimeout(show, DELAY_MS);
  });
  root.addEventListener('pointerout', (event) => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  for (const type of ['pointerdown', 'keydown', 'scroll', 'wheel']) root.addEventListener(type, hide, true);
  window.addEventListener('blur', hide);
  return { hide };
}
