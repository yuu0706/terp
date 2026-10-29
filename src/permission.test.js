const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'renderer/permission.js'), 'utf8');
  const { parsePermission, permissionSignature, permissionKeys, findClashes, urgencyRank } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let count = 0;
  const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); count++; };

  const boxed = [
    '╭──────────────────────────╮',
    '│ Bash command             │',
    '│                          │',
    '│   npm test               │',
    '│   Run tests              │',
    '│                          │',
    '│ Do you want to proceed?  │',
    '│ ❯ 1. Yes                 │',
    "│   2. Yes, and don't ask again for npm test commands in │",
    '│      /work/terp          │',
    '│   3. No, and tell Claude what to do differently (esc) │',
    '╰──────────────────────────╯',
  ].join('\n');
  check('枠付きの許可の画面を読む', parsePermission(boxed), {
    question: 'Do you want to proceed?', detail: ['Bash command', 'npm test', 'Run tests'],
    options: ['Yes', "Yes, and don't ask again for npm test commands in /work/terp", 'No, and tell Claude what to do differently (esc)'], cursor: 0,
  });
  const plain = [
    'ほかの出力',
    '────────────────',
    ' Edit file',
    ' src/app.js',
    '',
    ' Do you want to make this edit to app.js?',
    '   1. Yes',
    ' ❯ 2. Yes, allow all edits during this session (shift+tab)',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ].join('\n');
  const edit = parsePermission(plain);
  check('枠の無い画面は区切りの線から上を読まない', edit.detail, ['Edit file', 'src/app.js']);
  check('❯ の位置を今の選びにする', edit.cursor, 1);
  check('選択肢の後の案内は選択肢に入れない', edit.options.length, 3);
  check('選択肢が無ければ許可の画面とみなさない', parsePermission('Do you want to continue? [y/N]'), null);
  check('❯ が無ければ送らない', parsePermission('Do you want to proceed?\n  1. Yes\n  2. No'), null);
  check('番号が飛んでいれば選択肢に数えない', parsePermission('Do you want to proceed?\n❯ 1. Yes\n  3. No'), null);
  check('同じ画面なら同じ印', permissionSignature(parsePermission(boxed)), permissionSignature(parsePermission(boxed)));
  check('下へ2つ動かして Enter', permissionKeys(0, 2), '\x1b[B\x1b[B\r');
  check('上へ1つ動かして Enter', permissionKeys(2, 1), '\x1b[A\r');
  check('今の選びのままなら Enter だけ', permissionKeys(1, 1), '\r');

  const now = 10 * 60 * 1000;
  const clashes = findClashes([
    { id: 1, edits: [{ path: '/w/a.js', at: now - 1000 }, { path: '/w/b.js', at: now - 1000 }] },
    { id: 2, edits: [{ path: '/w/a.js', at: now - 2000 }] },
    { id: 3, edits: [{ path: '/w/b.js', at: 0 }] },
    { id: 4, edits: [{ path: '/w/b.js', at: now - 40 * 60 * 1000 }] },
  ], now);
  check('同じファイルを書き換えた組を両方に付ける', [...clashes], [[1, [{ path: '/w/a.js', others: [2] }]], [2, [{ path: '/w/a.js', others: [1] }]]]);
  check('許可待ちを先に、終わったを次に', ['working', 'done', 'idle', 'waiting'].map(urgencyRank), [2, 1, 3, 0]);
  console.log(`エージェントの見張り: ${count}例 OK`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
