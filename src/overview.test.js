const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'renderer/overview.js'), 'utf8');
  const { filterOverview, overviewNeighbor, tileLabels } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let count = 0;
  const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); count++; };
  const items = [
    { id: 1, name: 'API の調査', repoName: 'Terp', repoPath: '/work/Terp', branch: 'feature/Overview', cwd: '/work/Terp/src', workPath: '/work/Terp' },
    { id: 2, name: 'シェル', repoName: 'Tools', branch: 'main', cwd: '/personal/tools', workPath: '/personal/tools' },
    { id: 3, name: 'ログの確認', cwd: '/tmp/確認' },
  ];
  const ids = (query, list = items) => filterOverview(list, query).map((item) => item.id);
  check('空の検索は全件', ids(''), [1, 2, 3]);
  check('空白だけの検索は全件', ids(' \t '), [1, 2, 3]);
  check('名前の部分一致', ids('の調'), [1]);
  check('名前の英字は大小を区別しない', ids('api'), [1]);
  check('リポジトリ名の部分一致', ids('too'), [2]);
  check('リポジトリ名の英字は大小を区別しない', ids('TERP'), [1]);
  check('ブランチ名の部分一致', ids('OVERVIEW'), [1]);
  check('作業場所の部分一致', ids('/tmp/確認'), [3]);
  check('検索の前後の空白を除く', ids('  main  '), [2]);
  check('日本語の部分一致', ids('確認'), [3]);
  check('一致しないと空', ids('存在しない'), []);
  check('端末が無いと空', ids('api', []), []);
  check('未所属の端末の欠けた項目を扱える', ids('確認', [{ id: 4, name: '確認' }]), [4]);
  check('リポジトリのパスでも一致する', ids('/work/Terp', [{ id: 5, repoPath: '/work/Terp' }]), [5]);
  check('worktree のパスでも一致する', ids('/work/branch', [{ id: 6, workPath: '/work/branch' }]), [6]);
  check('検索のために正規表現を作らない', ids('[x]', [{ id: 7, name: '確認 [x]' }]), [7]);
  check('複数件の結果は入力の順序', ids('i', [items[1], items[0]]), [2, 1]);
  check('元の名前を変更しない', items[0].name, 'API の調査');
  check('要件でも絞れる', ids('ログイン', [{ id: 8, name: 'claude', requirement: 'ログイン画面の不具合を直す' }]), [8]);

  check('要件があれば見出しにし、ブランチとプログラムを下に出す',
    tileLabels({ name: 'ログイン画面の不具合を直す', requirement: 'ログイン画面の不具合を直す', branch: 'fix/login', program: 'claude' }),
    { main: 'ログイン画面の不具合を直す', meta: 'fix/login · claude' });
  check('自分で付けた名前は下の行に回す',
    tileLabels({ name: '調査用', customName: '調査用', requirement: 'API の遅さを調べる', branch: 'main', program: 'codex' }),
    { main: 'API の遅さを調べる', meta: '調査用 · main · codex' });
  check('要件が無ければ一覧の名前を見出しにする',
    tileLabels({ name: 'シェル', requirement: '', branch: 'main', program: 'シェル' }),
    { main: 'シェル', meta: 'main' });
  check('作業の外は場所を出す',
    tileLabels({ name: 'tools', requirement: '', place: '~/tools', program: 'シェル' }),
    { main: 'tools', meta: '~/tools · シェル' });

  const rect = (id, left, top, width = 100) => ({ id, left, top, width, height: 70 });
  const grid = [rect(1, 0, 0), rect(2, 110, 0), rect(3, 220, 0), rect(4, 0, 90), rect(5, 110, 90), rect(6, 0, 300, 210), rect(7, 220, 300, 210)];
  const neighbor = (id, direction, rects = grid) => overviewNeighbor(rects, id, direction);
  check('右隣へ', neighbor(1, 'ArrowRight'), 2);
  check('左隣へ', neighbor(3, 'ArrowLeft'), 2);
  check('同じ列の下へ', neighbor(2, 'ArrowDown'), 5);
  check('同じ列の上へ', neighbor(5, 'ArrowUp'), 2);
  check('最上段の上では止まる', neighbor(2, 'ArrowUp'), 2);
  check('最下段の下では止まる', neighbor(7, 'ArrowDown'), 7);
  check('左端で行をまたがない', neighbor(4, 'ArrowLeft'), 4);
  check('右端で行をまたがない', neighbor(5, 'ArrowRight'), 5);
  check('端が欠けた次の行は近い列へ', neighbor(3, 'ArrowDown'), 5);
  check('所属の間が空いていても下へ', neighbor(5, 'ArrowDown'), 6);
  check('幅の違うまとまりから上へ', neighbor(7, 'ArrowUp'), 5);
  check('横の距離より隣の行を優先する', neighbor(3, 'ArrowDown', [...grid, rect(8, 220, 500)]), 5);
  check('同距離なら左を選ぶ', neighbor(6, 'ArrowUp'), 4);
  check('消えた選択は最初の端末へ', neighbor(99, 'ArrowDown'), 1);
  check('空の一覧は選ばない', neighbor(1, 'ArrowDown', []), null);
  check('1枚なら動かない', neighbor(1, 'ArrowRight', [rect(1, 0, 0)]), 1);
  check('対象でないキーでは動かない', neighbor(1, 'Enter'), 1);
  check('DOM の登録順によらず位置で選ぶ', neighbor(1, 'ArrowRight', [...grid].reverse()), 2);
  check('1列に縮めると次の行へ', neighbor(1, 'ArrowDown', [rect(1, 0, 0), rect(2, 0, 90), rect(3, 0, 180)]), 2);
  check('スクロール後の負の位置でも上へ', neighbor(2, 'ArrowUp', [rect(1, 0, -100), rect(2, 0, -10)]), 1);
  check('隣の行の高さが異なっても上へ', neighbor(2, 'ArrowUp', [{ ...rect(1, 0, 0), height: 150 }, rect(2, 0, 170)]), 1);
  check('丸め誤差のある同じ行でも右へ', neighbor(1, 'ArrowRight', [rect(1, 0, 0.25), rect(2, 110, 0.5)]), 2);
  console.log(`全体の一覧: ${count}例 OK`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
