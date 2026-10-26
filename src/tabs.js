// ファイルのタブと、ターミナルを含む並び・表示中のタブの控え（~/.config/terp/tabs.json）
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const TABS_PATH = path.join(CONFIG_DIR, 'tabs.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(TABS_PATH, 'utf8'));
    const files = Array.isArray(data?.files) ? data.files : [];
    return {
      files: files.filter((file) => {
        if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      }),
      order: Array.isArray(data?.order) ? data.order.filter((key) => typeof key === 'string') : [],
      active: typeof data?.active === 'string' ? data.active : null,
      layout: data?.layout || null,
      workspaces: data?.workspaces && typeof data.workspaces === 'object' && !Array.isArray(data.workspaces)
        ? Object.fromEntries(Object.entries(data.workspaces).filter(([, state]) => state && typeof state === 'object' && !Array.isArray(state))) : null,
      fileWorkspaces: data?.fileWorkspaces && typeof data.fileWorkspaces === 'object' ? data.fileWorkspaces : {},
    };
  } catch {
    return { files: [], order: [], active: null, layout: null };
  }
}

function save({ files, order, active, layout, workspaces, fileWorkspaces }) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = JSON.stringify({ files, order, active, layout, workspaces, fileWorkspaces }, null, 2) + '\n';
  // 書きかけのファイルを読まれないよう、別名で書いてから置き換える
  const tmp = `${TABS_PATH}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, TABS_PATH);
}

module.exports = { load, save };
