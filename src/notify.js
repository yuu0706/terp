const { Notification } = require('electron');
const config = require('./config');

const selftest = Boolean(process.env.TERP_SELFTEST);
const shown = [];
// 通知を押すまで参照を保つ。同じ端末の古い通知は置き換える
const active = new Map();
let getWindow = () => null;
let toWindow = () => {};

function init(options) {
  ({ getWindow, toWindow } = options);
}

function close(id) {
  const entry = active.get(id);
  if (!entry) return;
  active.delete(id);
  entry.notification?.close();
}

function activate(id) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  // restore・show・focus は自己診断で利用者の入力を奪うため使わない
  if (selftest) win.showInactive();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (id !== null) toWindow('notify:activate', id);
}

function show({ id = null, title, body }) {
  if (id !== null && !Number.isSafeInteger(id)) throw new Error('通知先のターミナルを確認する');
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('通知の題と本文を確認する');
  if (!selftest && !Notification.isSupported()) return false;
  const options = { title, body, silent: !config.loadConfig().notifySound };
  close(id);
  const entry = { notification: null, index: shown.length };
  active.set(id, entry);
  const forget = () => {
    if (active.get(id) === entry) active.delete(id);
  };
  entry.click = () => {
    if (active.get(id) !== entry) return;
    close(id);
    activate(id);
  };
  if (selftest) {
    shown.push({ id, ...options });
    return true;
  }
  try {
    entry.notification = new Notification(options);
    entry.notification.on('click', entry.click);
    entry.notification.on('close', forget);
    entry.notification.on('failed', forget);
    entry.notification.show();
  } catch (err) {
    close(id);
    throw err;
  }
  return true;
}

module.exports = {
  init, show, close,
  __test: selftest ? {
    shown,
    click(index) {
      const record = shown[index];
      const entry = record && active.get(record.id);
      if (entry && entry.index === index) entry.click();
    },
  } : undefined,
};
