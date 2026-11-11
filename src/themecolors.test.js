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

test('明るい地に薄い強調色なら、暗くして地とのコントラスト比を 3 以上にする', () => {
  const light = { ...dark, background: '#f8f9fa', foreground: '#5c6166', cursor: '#ffaa33' };
  const chrome = config.chromeColors(light, '#ffaa33');
  assert.notEqual(chrome.accent, '#ffaa33');
  assert.ok(config.contrastRatio(chrome.accent, chrome.bg) >= 3, chrome.accent);
  assert.ok(config.contrastRatio(chrome.accent, chrome['term-bg']) >= 3, chrome.accent);
  assert.ok(config.contrastRatio(chrome.accent, '#000000') < config.contrastRatio('#ffaa33', '#000000'), '暗い向きに寄せる');
});

test('暗い地に暗い強調色なら、明るくして地とのコントラスト比を 3 以上にする', () => {
  const chrome = config.chromeColors(dark, '#202040');
  assert.ok(config.contrastRatio(chrome.accent, chrome.bg) >= 3, chrome.accent);
  assert.ok(config.contrastRatio(chrome.accent, chrome['term-bg']) >= 3, chrome.accent);
  assert.ok(config.contrastRatio(chrome.accent, '#ffffff') < config.contrastRatio('#202040', '#ffffff'), '明るい向きに寄せる');
});

test('地から十分離れた強調色は変えない', () => {
  assert.equal(config.chromeColors(dark, '#ff2bd6').accent, '#ff2bd6');
  assert.equal(config.chromeColors({ ...dark, background: '#ffffff', foreground: '#1a1a1a', appBackground: '#e6ecf5' }, '#1a1a1a').accent, '#1a1a1a');
});

test('鮮やかで地から離れた強調色なら、表示中の行の面は 22% のまま', () => {
  const chrome = config.chromeColors(dark, '#ff2bd6');
  assert.equal(chrome['accent-fill'], '22%');
  assert.equal(chrome['accent-fill-row'], '12%');
});

test('地に近い強調色なら、表示中の行の面を濃くする', () => {
  const chrome = config.chromeColors({ ...dark, background: '#d9b591', appBackground: '#ad9173', foreground: '#2d2006' }, '#60430e');
  assert.ok(parseInt(chrome['accent-fill'], 10) > 22, chrome['accent-fill']);
  assert.ok(parseInt(chrome['accent-fill-row'], 10) > 12, chrome['accent-fill-row']);
});

test('濃くしても地との差が届かなければ 40% で止める', () => {
  assert.equal(config.accentFill('#cccccc', '#cccccc'), 40);
  assert.equal(config.accentFill('rgba(0,0,0,0)', '#cccccc'), 22);
});
