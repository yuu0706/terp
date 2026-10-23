// タブで開いたファイルの表示（閲覧だけ）。行番号と色付けを付ける
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';

const terp = window.terp;

// 拡張子から言語を当てられないときだけ中身から推す。大きいファイルで推すと固まるため上限を設ける
const AUTO_DETECT_LIMIT = 100 * 1024;
// 色付けは重いため、これより大きいファイルは色を付けずに出す
const HIGHLIGHT_LIMIT = 512 * 1024;
const EXT_LANG = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', yml: 'yaml', zsh: 'bash', sh: 'bash', md: 'markdown', json5: 'json', tf: 'ini', toml: 'ini' };

function languageOf(file, text) {
  const name = file.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
  const lang = EXT_LANG[ext] || ext;
  if (hljs.getLanguage(lang)) return lang;
  if (name === 'Dockerfile') return 'dockerfile';
  if (name === 'Makefile') return 'makefile';
  return text.length <= AUTO_DETECT_LIMIT ? null : 'plaintext';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function notice(text, file) {
  const wrap = document.createElement('div');
  wrap.className = 'fileview__notice';
  const p = document.createElement('p');
  p.textContent = text;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = '既定のアプリで開く';
  btn.addEventListener('click', () => terp.openExternalFile(file));
  wrap.append(p, btn);
  return wrap;
}

function renderText(text, file) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const gutter = document.createElement('pre');
  gutter.className = 'fileview__gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_, i) => i + 1).join('\n');
  const code = document.createElement('code');
  code.className = 'hljs';
  if (text.length <= HIGHLIGHT_LIMIT) {
    const lang = languageOf(file, text);
    // highlight.js は文字を HTML に直して返す（< などは逃がし済み）
    code.innerHTML = lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(text).value;
  } else {
    code.textContent = text;
  }
  const pre = document.createElement('pre');
  pre.className = 'fileview__code';
  pre.append(code);
  const wrap = document.createElement('div');
  wrap.className = 'fileview__text';
  wrap.append(gutter, pre);
  return wrap;
}

// root は表示用の基準の場所（worktree の一番上）。見出しには root からの場所を出す
export async function renderFileView(el, file, root) {
  const rel = root && file.startsWith(root + '/') ? file.slice(root.length + 1) : file;
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'fileview__head';
  const title = document.createElement('span');
  title.className = 'fileview__title';
  title.textContent = rel;
  title.title = file;
  const meta = document.createElement('span');
  meta.className = 'fileview__meta';
  const actions = [
    ['再読み込み', () => renderFileView(el, file, root)],
    ['Finder で表示', () => terp.revealFile(file)],
    ['既定のアプリで開く', () => terp.openExternalFile(file)],
  ].map(([label, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--xs';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  });
  head.append(title, meta, ...actions);
  const body = document.createElement('div');
  body.className = 'fileview__body';
  body.tabIndex = 0;
  el.append(head, body);

  const res = await terp.readFile(file);
  if (!res.ok) {
    body.append(notice(`ファイルを読めません: ${res.error}`, file));
    return;
  }
  const r = res.value;
  meta.textContent = formatSize(r.size);
  if (r.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'fileview__image';
    img.src = r.url;
    img.alt = rel;
    body.append(img);
  } else if (r.kind === 'binary') {
    body.append(notice('バイナリのファイルのため、中身を表示しません', file));
  } else if (r.kind === 'too-large') {
    body.append(notice(`ファイルが大きいため（${formatSize(r.size)}）、中身を表示しません`, file));
  } else {
    body.append(renderText(r.text, file));
  }
}
