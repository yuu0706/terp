// WCAG の相対輝度。透過の値は一覧と同じものを渡し、色の調整では変えない。
function rgb(hex) {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

export function withAlpha(hex, alpha) {
  return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}

export function luminance(hex) {
  return rgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function favoriteText(accent, text) {
  if (contrast(accent, text) >= 4.5) return text;
  const source = rgb(text);
  // 各成分を同じ割合で下げ、色相を保ちながら暗くする。
  for (let step = 1; step <= 255; step++) {
    const color = '#' + source.map((n) => Math.floor(n * (255 - step) / 255).toString(16).padStart(2, '0')).join('');
    if (contrast(accent, color) >= 4.5) return color;
  }
  return '#000000';
}
