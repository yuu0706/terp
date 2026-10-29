const DEFAULT_ICON_COLORS = Object.freeze({
  top: '#2a2227',
  bottom: '#121011',
  accent: '#ff9ebb',
  muted: '#d8c4ca',
  text: '#fbe9ee',
});

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeColors(colors) {
  return Object.fromEntries(Object.entries(DEFAULT_ICON_COLORS).map(([key, fallback]) =>
    [key, validColor(colors?.[key]) ? colors[key].toLowerCase() : fallback]));
}

function iconColors(chrome) {
  const colors = normalizeColors({
    top: chrome?.['term-bg'],
    bottom: chrome?.bg,
    accent: chrome?.accent,
    muted: chrome?.['text-muted'],
    text: chrome?.text,
  });
  if (colors.top === colors.bottom && validColor(chrome?.bg)) {
    colors.bottom = '#' + colors.top.slice(1).match(/../g).map((hex) =>
      Math.max(0, parseInt(hex, 16) - Math.max(1, Math.round(parseInt(hex, 16) * 0.1))).toString(16).padStart(2, '0')).join('');
    // 黒はこれ以上暗くできないため、最小の差だけ付けて板の境目を残す
    if (colors.bottom === colors.top) colors.bottom = '#010101';
  }
  return colors;
}

function iconSvg(colors) {
  const { top, bottom, accent, muted, text } = normalizeColors(colors);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/>
      <stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
  </defs>
  <!-- macOS のアイコンの格子に合わせ、1024 の中に 824 の角丸の板を置く -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="3"/>
  <!-- 左の一覧 -->
  <rect x="190" y="300" width="150" height="34" rx="17" fill="${accent}"/>
  <rect x="190" y="380" width="150" height="34" rx="17" fill="${muted}" fill-opacity="0.45"/>
  <rect x="190" y="460" width="150" height="34" rx="17" fill="${muted}" fill-opacity="0.45"/>
  <line x1="390" y1="250" x2="390" y2="774" stroke="${muted}" stroke-opacity="0.18" stroke-width="6"/>
  <!-- プロンプト -->
  <path d="M470 400 L590 500 L470 600" fill="none" stroke="${accent}" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="630" y="590" width="170" height="52" rx="26" fill="${text}"/>
</svg>
`;
}

module.exports = { iconSvg, iconColors, DEFAULT_ICON_COLORS };
