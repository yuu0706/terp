const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'renderer/pet.js'), 'utf8');
  const { petAction, stepPet, spritePosition, crossings, PET_ANIMATIONS, DONE_JUMP_MS, PET_SPEEDS, WANDER_MOODS, HOP_MS } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let count = 0;
  const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); count++; };

  check('考え中は全力で走る', petAction('working'), 'dash');
  check('許可待ちは手を振る', petAction('waiting'), 'waving');
  check('終わった直後は跳ねる', petAction('done', { doneAt: 1000, now: 1000 + DONE_JUMP_MS - 1 }), 'jumping');
  check('終わってしばらくたつと気ままに動く', petAction('done', { doneAt: 1000, now: 1000 + DONE_JUMP_MS }), 'wander');
  check('ほかの状態は気ままに動く', petAction('idle'), 'wander');

  // 乱数を決めた値の並びにして、選ばれる動きを固定する
  const fixed = (...values) => { let i = 0; return () => values[i++ % values.length]; };
  const total = WANDER_MOODS.reduce((sum, m) => sum + m.weight, 0);
  const start = { x: 50, dir: 1, animation: 'running-right', frame: 0, elapsed: 0, mood: 'stand', moodLeft: 0, hopLeft: 0 };
  const dashed = stepPet(start, { action: 'dash', width: 1000, dt: 100, random: fixed(0.99) });
  check('考え中は速く走る', dashed.x, 50 + PET_SPEEDS.dash * 100);
  check('考え中は普段の走りより速い', PET_SPEEDS.dash > PET_SPEEDS.run && PET_SPEEDS.run > PET_SPEEDS.walk, true);
  const hopped = stepPet(start, { action: 'dash', width: 1000, dt: 100, random: fixed(0) });
  check('考え中はときどき、横向きの絵のまま弧を描いて跳ねながら進む', [hopped.animation, hopped.x > 50, hopped.lift > 0], ['running-right', true, true]);
  const landed = stepPet({ ...hopped }, { action: 'dash', width: 1000, dt: HOP_MS, random: fixed(0.99) });
  check('跳ね終わると地面に戻る', landed.lift, 0);
  const hopRoll = (total - 0.5) / total;
  const leaping = stepPet({ ...start, dir: -1 }, { action: 'wander', width: 1000, dt: 100, random: fixed(hopRoll, 0.5, 0.99) });
  check('気ままに跳ねるときも横向きのまま前へ跳ぶ', [leaping.mood, leaping.animation, leaping.x < 50, leaping.lift > 0], ['hop', 'running-left', true, true]);
  const party = stepPet(start, { action: 'jumping', width: 1000, dt: 100 });
  check('終わったときのお祝いだけ正面向きの跳ねる絵を使う', party.animation, 'jumping');
  const walking = stepPet(start, { action: 'wander', width: 1000, dt: 100, random: fixed(0, 0.5, 0.99) });
  check('気ままな動きで歩くを選ぶと、ゆっくり進む', [walking.mood, walking.animation, walking.x], ['walk', 'running-right', 50 + PET_SPEEDS.walk * 100]);
  const standRoll = (WANDER_MOODS[0].weight + WANDER_MOODS[1].weight + 0.5) / total;
  const standing = stepPet(start, { action: 'wander', width: 1000, dt: 100, random: fixed(standRoll, 0.5, 0.99) });
  check('立ち止まるを選ぶと、その場で座る', [standing.mood, standing.animation, standing.x], ['stand', 'idle', 50]);
  const kept = stepPet({ ...walking }, { action: 'wander', width: 1000, dt: 100, random: fixed(0.99) });
  check('選んだ動きは続く時間の間だけ続ける', kept.mood, 'walk');
  const turned = stepPet({ ...start, x: 99 }, { action: 'dash', width: 100, dt: 1000, random: fixed(0.99) });
  check('右の端に着いたら左へ折り返す', [turned.x, turned.dir, turned.animation], [100, -1, 'running-left']);
  const waving = stepPet(start, { action: 'waving', width: 1000, dt: 1000 });
  check('許可待ちは動かずに手を振る', [waving.x, waving.animation], [50, 'waving']);
  const durations = PET_ANIMATIONS['running-right'].durations;
  const advanced = stepPet(start, { action: 'dash', width: 10000, dt: (durations[0] + durations[1]) / 1.3 + 1, random: fixed(0.99) });
  check('表示時間を過ぎた分だけコマを進める', advanced.frame, 2);
  const still = stepPet(start, { action: 'dash', width: 100, dt: 1000, reduceMotion: true });
  check('動きを減らす設定では走らずコマも進めない', [still.x, still.frame], [50, 0]);
  const narrowed = stepPet({ ...start, x: 300 }, { action: 'waving', width: 100, dt: 0 });
  check('帯が狭くなったら内側へ戻す', narrowed.x, 100);
  check('すれ違ったら後ろの猫が跳ねる', [...crossings([10, 20, 90], [25, 15, 95])], [1]);
  check('すれ違わなければ跳ねない', [...crossings([10, 20], [12, 22])], []);

  const p = spritePosition('waving', 2, 32);
  const scale = 32 / 104;
  check('行とコマから背景の位置を出す', [p.x, p.y, p.width], [-2 * 96 * scale, -3 * 104 * scale, 96 * scale]);
  console.log(`ペット: ${count}例 OK`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
