export const PATH_DRAG_TYPE = 'text/x-terp-path';

export function escapePath(path) {
  return path.replace(/[ \t'"\\$`!&*()[\]{};<>?|#~]/g, '\\$&');
}

export function terminalPaths(paths) {
  return paths.length ? paths.map(escapePath).join(' ') + ' ' : '';
}

export function isPathDrop(dataTransfer, alt = false) {
  const types = Array.from(dataTransfer?.types || []);
  return types.includes('Files') || (alt && types.includes(PATH_DRAG_TYPE));
}

export function pathDropTarget(key, view) {
  if (key?.startsWith('t:') && view?.term) return 'terminal';
  if (key?.startsWith('f:') && view?.view?.editor) return 'editor';
  return null;
}

export function pathsFromTransfer(dataTransfer, pathForFile) {
  if (Array.from(dataTransfer?.types || []).includes('Files')) {
    return Array.from(dataTransfer.files || []).map((file) => {
      // 合成した File には実パスが無い。取得できない項目だけを除く。
      try { return pathForFile(file); } catch { return ''; }
    }).filter((path) => typeof path === 'string' && path.length > 0);
  }
  const path = dataTransfer?.getData(PATH_DRAG_TYPE);
  return path ? [path] : [];
}
