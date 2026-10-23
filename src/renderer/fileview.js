// タブで開いたファイル。文字は編集し、画像などは閲覧する
const terp = window.terp;
let monacoPromise = null;
let editorConfig = null;
const views = new Set();

function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = new Promise((resolve, reject) => {
      if (!terp.editorWorker.ok) return reject(new Error(terp.editorWorker.error));
      window.MonacoEnvironment = { getWorkerUrl: () => terp.editorWorker.value };
      window.require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    });
    monacoPromise.then(() => applyEditorConfig(editorConfig)).catch(() => {});
  }
  return monacoPromise;
}

export function applyEditorConfig(c) {
  editorConfig = c;
  const monaco = window.monaco;
  if (!monaco?.editor || !c) return;
  const t = c.terminal;
  const bg = t.background || c.chrome['term-bg'];
  const rgb = parseInt(bg.slice(1), 16);
  const light = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 > 128;
  const token = (name) => t[name].replace(/^#/, '');
  monaco.editor.defineTheme('terp', {
    base: light ? 'vs' : 'vs-dark',
    // 既定テーマの細かな構文色が、端末の配色より優先されるのを防ぐ
    inherit: false,
    rules: [
      { token: '', foreground: token('foreground') },
      { token: 'comment', foreground: token('brightBlack'), fontStyle: 'italic' },
      { token: 'keyword', foreground: token('magenta') },
      { token: 'string', foreground: token('green') },
      { token: 'number', foreground: token('yellow') },
      { token: 'type', foreground: token('cyan') },
      { token: 'type.identifier', foreground: token('cyan') },
      { token: 'identifier', foreground: token('foreground') },
      { token: 'delimiter', foreground: token('brightBlack') },
      { token: 'tag', foreground: token('blue') },
      { token: 'attribute.name', foreground: token('cyan') },
    ],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.foreground': t.foreground,
      'editor.selectionBackground': t.selectionBackground,
      'editor.inactiveSelectionBackground': t.selectionBackground,
      'editorLineNumber.foreground': t.brightBlack,
      'editorLineNumber.activeForeground': t.foreground,
      'editorCursor.foreground': t.cursor || t.foreground,
      'editor.lineHighlightBackground': '#00000000',
      'editorIndentGuide.background1': t.brightBlack,
      'editorIndentGuide.activeBackground1': t.blue,
    },
  });
  monaco.editor.setTheme('terp');
  for (const view of views) view.editor?.updateOptions({ fontFamily: c.font.family, fontSize: c.font.size });
}

function languageOf(monaco, file) {
  const name = file.split('/').pop();
  const languages = monaco.languages.getLanguages();
  const named = languages.find((l) => l.filenames?.includes(name));
  if (named) return named.id;
  const lower = name.toLowerCase();
  const matches = languages.flatMap((l) => (l.extensions || []).filter((ext) => lower.endsWith(ext.toLowerCase())).map((ext) => ({ id: l.id, length: ext.length })));
  return matches.sort((a, b) => b.length - a.length)[0]?.id || 'plaintext';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function button(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn--xs';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function notice(text, file) {
  const wrap = document.createElement('div');
  wrap.className = 'fileview__notice';
  const p = document.createElement('p');
  p.textContent = text;
  wrap.append(p, button('既定のアプリで開く', () => terp.openExternalFile(file)));
  return wrap;
}

// 状態はこの戻り値に集め、タブ側は dirty と editor を参照する
export function renderFileView(el, file, root, { confirm, onChange, isActive }) {
  const rel = root && file.startsWith(root + '/') ? file.slice(root.length + 1) : file;
  const view = { editor: null, dirty: false, mtime: null, ready: null, get saving() { return saving; }, reload, save, checkExternal, dispose };
  views.add(view);
  let savedText = '';
  let disposed = false;
  let busy = false;
  let loading = null;
  let checking = false;
  let saving = null;
  let observedMtime = null;
  let missing = false;
  let changeListener = null;
  const head = document.createElement('div');
  head.className = 'fileview__head';
  const title = document.createElement('span');
  title.className = 'fileview__title';
  title.textContent = rel;
  title.title = file;
  const meta = document.createElement('span');
  meta.className = 'fileview__meta';
  head.append(title, meta,
    button('再読み込み', () => reload()),
    button('Finder で表示', () => terp.revealFile(file)),
    button('既定のアプリで開く', () => terp.openExternalFile(file)));
  const banner = document.createElement('div');
  banner.className = 'fileview__banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  const body = document.createElement('div');
  body.className = 'fileview__body';
  body.tabIndex = 0;
  el.replaceChildren(head, banner, body);
  body.append(notice('読み込み中…', file));

  function updateDirty() {
    view.dirty = Boolean(view.editor && view.editor.getValue({ preserveBOM: true }) !== savedText);
    onChange();
  }

  function showBanner(message, actions = []) {
    if (disposed) return;
    const text = document.createElement('span');
    text.textContent = message;
    banner.replaceChildren(text, ...actions.map(([label, fn]) => button(label, fn)));
    banner.hidden = false;
  }

  function externalBanner() {
    showBanner('外で変更されました', [
      ['読み直す（この画面の変更を捨てる）', () => reload()],
      ['このまま', () => { banner.hidden = true; }],
    ]);
  }

  function disposeEditor() {
    changeListener?.dispose();
    changeListener = null;
    const model = view.editor?.getModel();
    view.editor?.dispose();
    model?.dispose();
    view.editor = null;
  }

  async function display(r) {
    if (r.kind === 'text') {
      const monaco = await loadMonaco();
      if (disposed) return;
      const newlyCreated = !view.editor;
      savedText = r.text;
      if (view.editor) {
        const state = view.editor.saveViewState();
        view.editor.setValue(r.text);
        view.editor.restoreViewState(state);
      } else {
        body.textContent = '';
        const host = document.createElement('div');
        host.className = 'fileview__editor';
        body.append(host);
        view.editor = monaco.editor.create(host, {
          value: r.text,
          language: languageOf(monaco, file),
          theme: 'terp',
          fontFamily: editorConfig.font.family,
          fontSize: editorConfig.font.size,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          ariaLabel: rel,
        });
        changeListener = view.editor.onDidChangeModelContent(updateDirty);
      }
      savedText = view.editor.getValue({ preserveBOM: true });
      if (newlyCreated && isActive() && !document.querySelector('dialog[open]')) view.editor.focus();
    } else {
      disposeEditor();
      body.textContent = '';
      if (r.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'fileview__image';
        img.src = r.url;
        img.alt = rel;
        body.append(img);
      } else if (r.kind === 'binary') {
        body.append(notice('バイナリのファイルのため、中身を表示しません', file));
      } else {
        body.append(notice(`ファイルが大きいため（${formatSize(r.size)}）、中身を表示しません`, file));
      }
    }
    view.mtime = r.mtime;
    observedMtime = r.mtime;
    missing = false;
    meta.textContent = formatSize(r.size);
    banner.hidden = true;
    updateDirty();
  }

  function reload(automatic = false) {
    if (disposed || busy || saving) return Promise.resolve(false);
    loading = reloadContent(automatic).finally(() => { loading = null; });
    return loading;
  }

  async function reloadContent(automatic) {
    busy = true;
    try {
      if (!automatic && view.dirty) {
        const choice = await confirm({ title: 'ファイルを読み直す', message: `${rel} の未保存の変更を捨てる`, accept: '変更を捨てて読み直す' });
        if (choice !== 'accept' || disposed) return false;
      }
      const version = view.editor?.getModel().getVersionId();
      const res = await terp.readFile(file);
      if (disposed) return false;
      if (!res.ok) {
        if (view.editor) showBanner(`ファイルを読めません: ${res.error}`, [['再読み込み', () => reload()]]);
        else body.replaceChildren(notice(`ファイルを読めません: ${res.error}`, file));
        return false;
      }
      // 読み出しを待つ間に打った文字も、外の内容で置き換えない
      if (view.editor && (view.editor.getModel().getVersionId() !== version || (automatic && view.dirty))) {
        observedMtime = res.value.mtime;
        externalBanner();
        return false;
      }
      await display(res.value);
      return !disposed;
    } catch (err) {
      if (!disposed) showBanner(`エディタを開けません: ${err.message}`, [['再読み込み', () => reload()]]);
      return false;
    } finally {
      busy = false;
    }
  }

  function save() {
    if (saving) return saving;
    saving = saveContent().catch((err) => {
      showBanner(`保存できません: ${err.message}`, [['保存を再試行', () => save()]]);
      return false;
    }).finally(() => { saving = null; });
    return saving;
  }

  async function saveContent() {
    if (loading) await loading;
    if (disposed || !view.editor) return false;
    if (!view.dirty) return true;
    const text = view.editor.getValue({ preserveBOM: true });
    let res = await terp.writeFile({ file, text, mtime: view.mtime });
    if (disposed) return false;
    if (res.ok && res.value.conflict) {
      const choice = await confirm({ title: '外の変更を上書き', message: `${rel} は外で変更されたか、削除された。保存すると外の変更が失われる`, accept: '上書きする' });
      if (choice !== 'accept' || disposed) return false;
      res = await terp.writeFile({ file, text, mtime: view.mtime, force: true });
    }
    if (disposed) return false;
    if (!res.ok) {
      showBanner(`保存できません: ${res.error}`, [['保存を再試行', () => save()]]);
      return false;
    }
    savedText = text;
    view.mtime = res.value.mtime;
    observedMtime = view.mtime;
    missing = false;
    meta.textContent = formatSize(res.value.size);
    banner.hidden = true;
    updateDirty();
    return !view.dirty;
  }

  async function checkExternal() {
    if (disposed || busy || saving || checking || !view.editor) return;
    checking = true;
    let refresh = false;
    try {
      const res = await terp.statFile(file);
      if (disposed || busy || saving) return;
      if (!res.ok) {
        showBanner(`更新を確認できません: ${res.error}`);
        return;
      }
      if (!res.value.exists) {
        missing = true;
        showBanner('このファイルは消えました');
      } else if (missing || res.value.mtime !== observedMtime || (!view.dirty && res.value.mtime !== view.mtime)) {
        observedMtime = res.value.mtime;
        missing = false;
        if (view.dirty) externalBanner();
        else refresh = true;
      }
    } finally {
      checking = false;
    }
    if (refresh) {
      const loaded = await reload(true);
      if (!loaded && !view.dirty) observedMtime = view.mtime;
    }
  }

  function dispose() {
    disposed = true;
    views.delete(view);
    disposeEditor();
  }

  view.ready = reload();
  return view;
}
