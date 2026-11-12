// ファイルの入出力と環境は呼び出し側から渡し、読み取りと変換を個別に確かめられるようにする
const path = require('path');

function ghosttyConfigPaths({ env, home }) {
  if (env.TERP_GHOSTTY_CONFIG) return [path.resolve(env.TERP_GHOSTTY_CONFIG)];
  return [env.XDG_CONFIG_HOME || path.join(home, '.config'), path.join(home, 'Library', 'Application Support')]
    .flatMap((dir, i) => ['config.ghostty', 'config'].map((name) =>
      path.join(dir, i === 0 ? 'ghostty' : 'com.mitchellh.ghostty', name)));
}

function parseGhosttyConfig(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    entries.push({ key, value });
  }
  return entries;
}

function readGhosttyConfig({ paths, readFile, realpath = (file) => file, home }) {
  const entries = [];
  const files = [];
  const visited = new Set();
  const read = (file, optional) => {
    let canonical;
    let text;
    try {
      canonical = realpath(file);
      if (visited.has(canonical)) return;
      text = readFile(file);
    } catch (err) {
      if (optional && err.code === 'ENOENT') return;
      throw new Error(`Ghostty の設定を読めない: ${file}（${err.message}）`);
    }
    visited.add(canonical);
    files.push(file);
    const includes = [];
    for (const entry of parseGhosttyConfig(text)) {
      if (entry.key === 'config-file') includes.push(entry.value);
      else entries.push(entry);
    }
    // Ghostty と同じく、記述元の値を読んだ後に追加のファイルを読む
    for (let include of includes) {
      const optionalInclude = include.startsWith('?');
      if (optionalInclude) include = include.slice(1);
      if (!include) throw new Error(`config-file のパスを指定する: ${file}`);
      if (include.startsWith('~/')) include = path.join(home, include.slice(2));
      read(path.resolve(path.dirname(file), include), optionalInclude);
    }
  };
  paths.forEach((file) => read(file, true));
  return { entries, files };
}

function mapGhosttyConfig(entries, { themeExists }) {
  const changes = {};
  const skipped = [];
  const latest = new Map();
  const families = [];
  const palette = {};
  const skip = (entry, reason) => skipped.push({ ...entry, reason });
  const hex = (value) => (/^#?[0-9a-fA-F]{6}$/.test(value) ? `#${value.replace(/^#/, '').toLowerCase()}` : null);
  for (const entry of entries) {
    if (entry.key === 'font-family') {
      if (entry.value === '') families.length = 0;
      else families.push(entry.value);
    }
    // palette は番号ごとに何行も書くため、行ごとに読む。後に読んだ値を優先する
    if (entry.key === 'palette') {
      const m = entry.value.match(/^(\d+)\s*=\s*(\S+)$/);
      const color = m && Number(m[1]) < 16 ? hex(m[2]) : null;
      if (color) palette[m[1]] = color;
      else skip(entry, '0〜15 の番号と #rrggbb の色で指定する');
      continue;
    }
    // 別名のぼかしも、後に読んだ値を優先する
    latest.set(entry.key === 'background-blur-radius' ? 'background-blur' : entry.key, entry);
  }
  const number = (value) => value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const bounded = (entry, key, min, max) => {
    const n = number(entry.value);
    if (n === null) skip(entry, '数値で指定する');
    else changes[key] = Math.max(min, Math.min(max, n));
  };
  for (const [key, entry] of latest) {
    const { value } = entry;
    switch (key) {
      case 'theme': {
        const name = /^(?:light|dark):/.test(value)
          ? value.split(',').map((part) => part.trim()).find((part) => part.startsWith('dark:'))?.slice(5).trim()
          : value;
        if (name && themeExists(name)) changes.theme = name;
        else skip(entry, 'テーマが見つからない');
        break;
      }
      case 'font-family':
        changes.fontFamily = [...families.map((name) => JSON.stringify(name)), 'Menlo', '"Hiragino Sans"', 'monospace'].join(', ');
        break;
      case 'font-size': bounded(entry, 'fontSize', 9, 32); break;
      case 'background-opacity': bounded(entry, 'backgroundOpacity', 0.2, 1); break;
      case 'minimum-contrast': bounded(entry, 'minimumContrast', 1, 21); break;
      case 'background-blur':
        if (value === 'true' || value === 'false') changes.backgroundBlur = value === 'true';
        else bounded(entry, 'backgroundBlur', 0, 100);
        break;
      case 'window-padding-x':
      case 'window-padding-y': {
        const parts = value.split(',').map((part) => number(part.trim()));
        if (parts.length > 2 || parts.some((n) => n === null || n < 0)) skip(entry, '余白は0以上の数値を1つか2つ指定する');
        else changes[key === 'window-padding-x' ? 'paddingX' : 'paddingY'] =
          Math.max(0, Math.min(40, Math.round(parts.reduce((sum, n) => sum + n, 0) / parts.length)));
        break;
      }
      case 'cursor-style':
        if (['block', 'bar', 'underline', 'block_hollow'].includes(value)) {
          changes.cursorStyle = value === 'block_hollow' ? 'block' : value;
          if (value === 'block_hollow') skip(entry, '中抜きの形は使えないため block にする');
        } else skip(entry, 'カーソルの形が見つからない');
        break;
      case 'cursor-style-blink':
        if (value === 'true' || value === 'false') changes.cursorBlink = value === 'true';
        else skip(entry, 'true か false で指定する');
        break;
      case 'foreground':
      case 'background': {
        const color = hex(value);
        if (color) changes[key] = color;
        else skip(entry, '#rrggbb の色で指定する（色の名前は読めない）');
        break;
      }
      case 'macos-option-as-alt': skip(entry, 'terp は常に Meta'); break;
      default: skip(entry, 'terp に無い');
    }
  }
  if (Object.keys(palette).length) changes.palette = palette;
  return { changes, skipped };
}

module.exports = { ghosttyConfigPaths, parseGhosttyConfig, readGhosttyConfig, mapGhosttyConfig };
