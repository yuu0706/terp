// Markdown のファイルのプレビュー。marked で HTML にし、DOMPurify でスクリプトや on* 属性を取り除いてから出す。
// 相対パスの画像はファイルの場所から解決し、見出しには GitHub と同じ形の id を付けてページ内のリンクを効かせる
let libraries = null;

function loadLibraries() {
  libraries ||= Promise.all([
    import('../../node_modules/marked/lib/marked.esm.js'),
    import('../../node_modules/dompurify/dist/purify.es.mjs'),
  ]).then(([{ marked }, { default: DOMPurify }]) => ({ marked, DOMPurify }));
  return libraries;
}

export function isMarkdown(file) {
  return /\.(md|markdown|mdown|mkd)$/i.test(file);
}

// GitHub の見出しの id と同じく、小文字にし、記号を除き、空白を - にする。同じ見出しには -1, -2 を付ける
export function slugify(text, seen = new Map()) {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

// リンク先の分類。外へ出すもの（http・https・mailto）、ページ内（#）、ファイル（相対・絶対のパス）
export function linkTarget(href, file) {
  if (!href) return null;
  if (href.startsWith('#')) return { kind: 'anchor', id: decodeURIComponent(href.slice(1)) };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const [pathPart, hash = ''] = href.split('#');
  if (!pathPart) return null;
  return { kind: 'file', path: resolvePath(file, decodeURIComponent(pathPart)), id: hash ? decodeURIComponent(hash) : '' };
}

// Markdown のファイルの場所を基準に、相対パスを絶対パスにする
export function resolvePath(file, relative) {
  const parts = (relative.startsWith('/') ? relative : file.replace(/\/[^/]*$/, '') + '/' + relative).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

function fileUrl(path) {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

// 本文を描き、要素の並び（DocumentFragment）を返す
export async function renderMarkdown(text, file) {
  const { marked, DOMPurify } = await loadLibraries();
  const html = marked.parse(text, { gfm: true, async: false });
  const clean = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'] });
  const seen = new Map();
  for (const heading of clean.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.id = slugify(heading.textContent, seen);
  for (const img of clean.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^(https?:|data:)/i.test(src)) continue;
    const target = linkTarget(src, file);
    if (target?.kind === 'file') img.src = fileUrl(target.path);
  }
  // チェックボックスは表示だけにする（押しても元の文書は変わらないため）
  for (const box of clean.querySelectorAll('input[type="checkbox"]')) box.disabled = true;
  return clean;
}
