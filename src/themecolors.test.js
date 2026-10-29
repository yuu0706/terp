// アプリの枠の色（config.js の chromeColors）と、AI のテーマに結びつけたアプリの背景色を確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-themecolors-'));
process.env.TERP_CONFIG_DIR = dir;
const config = require('./config');

const dark = {
  background: '#0a0a14', foreground: '#e8e8ff', cursor: '#ff2bd6',
  palette: ['#1a1a2e', '#ff2e63', '#39ff14', '#ffe600', '#1f51ff', '#b026ff', '#00f0ff', '#d8d8f0',
    '#3a3a5c', '#ff6e8a', '#7dff6b', '#fff27a', '#5c8dff', '#d580ff', '#7ff7ff', '#ffffff'],
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('アプリの背景色が無ければ、文字はテーマの文字色のまま', () => {
  assert.equal(config.chromeColors(dark, '#ff2bd6').text, dark.foreground);
});

test('暗いテーマに明るいアプリの背景色を重ねても、一覧の文字は読める色になる', () => {
  const chrome = config.chromeColors({ ...dark, appBackground: '#e6ecf5' }, '#ff2bd6');
  assert.equal(chrome.bg, '#e6ecf5');
  assert.ok(config.contrastRatio(chrome.text, chrome.bg) >= 4.5, chrome.text);
  assert.equal(chrome['term-bg'], dark.background);
});

test('AI のテーマに結びつけたアプリの背景色は、そのテーマのときだけ使う', () => {
  fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'themes', 'Night'), 'background = #0a0a14\nforeground = #e8e8ff\n');
  fs.writeFileSync(path.join(dir, 'themes', 'Day'), 'background = #ffffff\nforeground = #1a1a1a\n');
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ theme: 'Night', appBackground: '#20304a', appBackgroundTheme: 'Day' }));
  assert.notEqual(config.loadConfig().chrome.bg, '#20304a');
  assert.notEqual(config.getThemeColors('Night').chrome.bg, '#20304a');
  assert.equal(config.getThemeColors('Day').chrome.bg, '#20304a');
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ theme: 'Day', appBackground: '#20304a', appBackgroundTheme: 'Day' }));
  assert.equal(config.loadConfig().chrome.bg, '#20304a');
});

test('テーマの印の無いアプリの背景色は、どのテーマでも使わない', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ theme: 'Night', appBackground: '#20304a' }));
  assert.notEqual(config.loadConfig().chrome.bg, '#20304a');
  assert.notEqual(config.getThemeColors('Day').chrome.bg, '#20304a');
});

test('既定のテーマで決めたアプリの背景色は、空の印で既定のテーマにだけ使う', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ appBackground: '#20304a', appBackgroundTheme: '' }));
  assert.equal(config.loadConfig().chrome.bg, '#20304a');
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ theme: 'Night', appBackground: '#20304a', appBackgroundTheme: '' }));
  assert.notEqual(config.loadConfig().chrome.bg, '#20304a');
});
