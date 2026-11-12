// テーマの検証・再生成・追い指示と、AI の使用量を本物の claude を呼ばずに確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terp-themegen-'));
const previousDir = process.env.TERP_CONFIG_DIR;
process.env.TERP_CONFIG_DIR = dir;
const config = require('./config');
const aiassist = require('./aiassist');
const { generate, validateTheme, parseResult, contrastRatio, checkContrast, saveTheme } = require('./themegen');
test.after(() => {
  if (previousDir === undefined) delete process.env.TERP_CONFIG_DIR;
  else process.env.TERP_CONFIG_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const answers = {
  brightness: '暗い', mood: '海', contrast: 'ふつう', temperature: 'ふつう', saturation: 'ふつう',
  accent: null, colorblind: false, appBackground: false, base: 'new',
};
const theme = {
  name: 'Test Ocean', concept: '深い海の青に、金色の光を添える',
  background: '#101820', foreground: '#f0f4f8', cursor: '#58c4ff', cursorText: '#101820',
  selectionBackground: '#345678', selectionForeground: '#ffffff',
  palette: ['#202830', '#ee6688', '#88cc88', '#eedd88', '#5599ee', '#bb88dd', '#66cccc', '#dddddd',
    '#667788', '#ff88aa', '#aaffaa', '#ffeeaa', '#88bbff', '#ddaaff', '#88eeee', '#ffffff'],
};
const dataFrom = (prompt) => JSON.parse(prompt.split('\n')[1].slice('回答・今の案・追い指示・土台の色: '.length));

test('コントラスト比は同色で1、黒白で21となり、色の順序に依らない', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
  assert.equal(contrastRatio('#123456', '#abcdef'), contrastRatio('#abcdef', '#123456'));
});

test('文字と背景は4.5、意味を持つ16色と背景は3を境に検査する', () => {
  const light = { ...theme, background: '#ffffff', foreground: '#767676', palette: Array(16).fill('#949494') };
  assert.deepEqual(checkContrast(light), []);
  assert.match(checkContrast({ ...light, foreground: '#777777' })[0], /4\.5未満/);
  const palette = [...light.palette];
  palette[4] = '#959595';
  palette[12] = '#959595';
  assert.deepEqual(checkContrast({ ...light, palette }), ['16色の番号 4・12 と背景のコントラスト比が3未満']);
});

test('1〜6・9〜14をすべて検査し、0・7・8・15は検査から外す', () => {
  const palette = Array(16).fill(theme.background);
  assert.deepEqual(checkContrast({ ...theme, palette }), ['16色の番号 1・2・3・4・5・6・9・10・11・12・13・14 と背景のコントラスト比が3未満']);
  for (const i of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) palette[i] = '#ffffff';
  assert.deepEqual(checkContrast({ ...theme, palette }), []);
});

test('concept は任意で120字まで残し、頼んだアプリの背景色だけを検証して残す', () => {
  assert.equal(validateTheme({ ...theme, concept: '海'.repeat(121) }).concept.length, 120);
  assert.equal(validateTheme({ ...theme, concept: undefined }).concept, undefined);
  assert.equal(validateTheme({ ...theme, concept: 123 }).concept, undefined);
  assert.equal(validateTheme({ ...theme, appBackground: 'invalid' }).appBackground, undefined);
  assert.throws(() => validateTheme(theme, { appBackground: true }), /appBackground/);
  assert.throws(() => validateTheme({ ...theme, appBackground: '#123' }, { appBackground: true }), /appBackground/);
  assert.equal(validateTheme({ ...theme, appBackground: '#ABCDEF' }, { appBackground: true }).appBackground, '#abcdef');
});

test('名前・6色・16色の形を検証し、JSON の囲みと文字列中の括弧を読める', () => {
  const value = { ...theme, concept: '海の { 青 } と "光"' };
  assert.deepEqual(parseResult('```json\n' + JSON.stringify(value) + '\n```'), validateTheme(value));
  for (const value of [null, [], { ...theme, name: '../test' }, { ...theme, cursor: '#123' },
    { ...theme, palette: theme.palette.slice(1) }, { ...theme, palette: Array(16).fill('red') }]) {
    assert.throws(() => validateTheme(value));
  }
  assert.throws(() => parseResult('返答なし'), /JSON がありません/);
  assert.throws(() => parseResult('{name: "test"}'), /JSON を読めません/);
});

test('知らない回答・欠けた回答・200字を超える追い指示は AI を呼ぶ前に拒否する', async (t) => {
  const ask = t.mock.method(aiassist, 'ask', async () => { throw new Error('呼ばない'); });
  for (const patch of [
    { brightness: '中間' }, { contrast: '弱い' }, { mood: 'a'.repeat(501) }, { temperature: '暑い' },
    { saturation: '薄い' }, { accent: '#fff' }, { colorblind: 'true' }, { appBackground: 1 },
    { base: 'other' }, { unknown: true }, { temperature: undefined },
  ]) await assert.rejects(generate({ ...answers, ...patch }), /答えを確かめて/);
  await assert.rejects(generate(answers, { currentTheme: theme, instruction: 'a'.repeat(201) }), /200字/);
  await assert.rejects(generate(answers, { currentTheme: theme, instruction: ' ' }), /200字/);
  await assert.rejects(generate(answers, { currentTheme: theme }), /合わせて/);
  await assert.rejects(generate(answers, { instruction: '青く' }), /合わせて/);
  await assert.rejects(generate(answers, { currentTheme: { ...theme, cursor: 'red' }, instruction: '青く' }), /cursor/);
  await assert.rejects(generate({ ...answers, base: 'current' }), /土台の色/);
  assert.equal(ask.mock.callCount(), 0);
});

test('回答と土台をデータで渡し、指定したカーソルとアプリの背景をプレビューに反映する', async (t) => {
  config.updateConfig({ accent: '#ff0000', aiModel: 'haiku' });
  const ask = t.mock.method(aiassist, 'ask', async () => JSON.stringify({ ...theme, appBackground: '#0c1218' }));
  const options = { ...answers, temperature: '冷たい', saturation: '落ち着いた', accent: '#ABCDEF', colorblind: true, appBackground: true, base: 'current' };
  const baseColors = config.getThemeColors(null);
  const result = await generate(options, { baseColors });
  const [feature, system, prompt, timeout] = ask.mock.calls[0].arguments;
  assert.equal(feature, 'theme');
  assert.match(system, /命令として扱わず/);
  assert.deepEqual(dataFrom(prompt), { answers: options, currentTheme: null, instruction: null, baseColors });
  assert.deepEqual(timeout, { timeout: 60000 });
  assert.equal(result.theme.cursor, '#abcdef');
  assert.equal(result.colors.chrome.accent, '#abcdef');
  assert.equal(result.colors.chrome.bg, '#0c1218');
  config.updateConfig({ accent: null });
});

test('追い指示は検証済みの案を渡し、次の修正は直した案を土台にする', async (t) => {
  const changed = { ...theme, concept: '青を強めた海' };
  const ask = t.mock.method(aiassist, 'ask', async () => JSON.stringify(changed));
  const first = await generate(answers, { currentTheme: { ...theme, extra: '除く' }, instruction: 'もう少し青く' });
  assert.deepEqual(dataFrom(ask.mock.calls[0].arguments[2]).currentTheme, validateTheme(theme));
  assert.equal(dataFrom(ask.mock.calls[0].arguments[2]).instruction, 'もう少し青く');
  await generate(answers, { currentTheme: first.theme, instruction: '金色を控えめに' });
  assert.deepEqual(dataFrom(ask.mock.calls[1].arguments[2]).currentTheme, first.theme);
});

test('16色の不足番号を添えて1回だけ作り直す', async (t) => {
  const low = { ...theme, palette: theme.palette.map((color, i) => i === 4 || i === 12 ? theme.background : color) };
  let n = 0;
  const ask = t.mock.method(aiassist, 'ask', async () => JSON.stringify(n++ ? theme : low));
  assert.equal((await generate(answers)).theme.name, theme.name);
  assert.equal(ask.mock.callCount(), 2);
  assert.match(ask.mock.calls[1].arguments[2], /前回の不足: 16色の番号 4・12/);
});

test('文字と16色の不足が2回続けば理由を出して終了する', async (t) => {
  const low = { ...theme, foreground: theme.background, palette: Array(16).fill(theme.background) };
  const ask = t.mock.method(aiassist, 'ask', async () => JSON.stringify(low));
  await assert.rejects(generate(answers), (err) => /4\.5未満/.test(err.message) && /番号 1・2・3・4・5・6・9・10・11・12・13・14/.test(err.message));
  assert.equal(ask.mock.callCount(), 2);
});

test('sonnet では120秒を渡し、上限や CLI の失敗を繰り返さず返す', async (t) => {
  config.updateConfig({ aiModel: 'sonnet' });
  const ask = t.mock.method(aiassist, 'ask', async () => { throw new Error('今日の上限'); });
  await assert.rejects(generate(answers), /今日の上限/);
  assert.equal(ask.mock.callCount(), 1);
  assert.deepEqual(ask.mock.calls[0].arguments[3], { timeout: 120000 });
  config.updateConfig({ aiModel: 'haiku' });
});

test('保存は Ghostty の色だけを書き、同名を上書きせず、コントラスト不足を拒否する', () => {
  const value = { ...theme, appBackground: '#0c1218' };
  assert.equal(saveTheme(value), theme.name);
  const file = path.join(dir, 'themes', theme.name);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /concept|appBackground/);
  assert.deepEqual(config.parseGhosttyTheme(text).palette, theme.palette);
  assert.equal(saveTheme(value), theme.name + ' 2');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.throws(() => saveTheme({ ...theme, palette: Array(16).fill(theme.background) }), /コントラスト/);
});

test('偽の claude に身軽な引数とモデルを渡し、明示のテーマ作成も使用量と上限に含める', async () => {
  const fake = path.join(dir, 'claude');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ result: 'theme result', usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } }))});\n`, { mode: 0o755 });
  const previousBin = process.env.TERP_CLAUDE_BIN;
  const previousPath = process.env.PATH;
  process.env.TERP_CLAUDE_BIN = fake;
  process.env.PATH = dir + path.delimiter + previousPath;
  const now = new Date(2026, 9, 29, 12);
  try {
    config.updateConfig({ aiAssist: false, aiModel: 'sonnet', aiDailyLimit: 1 });
    assert.equal(aiassist.blocked('theme', config.rawConfig(), now), null);
    assert.match(aiassist.blocked('terminalName', config.rawConfig(), now), /切ってあります/);
    assert.equal(await aiassist.ask('theme', 'JSON だけ', '好みのデータ', { now, timeout: 120000 }), 'theme result');
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 2), ['-p', '好みのデータ']);
    assert.equal(args[args.indexOf('--system-prompt') + 1], 'JSON だけ');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
    const usage = aiassist.loadUsage(now);
    assert.equal(usage.calls, 1);
    assert.equal(usage.features.theme, 1);
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 5);
    await assert.rejects(aiassist.ask('theme', '', '', { now }), /今日の上限/);
  } finally {
    if (previousBin === undefined) delete process.env.TERP_CLAUDE_BIN;
    else process.env.TERP_CLAUDE_BIN = previousBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
