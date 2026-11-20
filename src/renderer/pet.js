// 上の帯を歩くペット（2026-11-18 利用者の指示）。エージェントを動かしているターミナル1つにつき1匹出し、状態で動きを変える。
// 猫と犬の絵は Codex のペットと同じ並び（8列、行ごとに動き）のスプライトシートを使う。使う 0〜4 行だけを、1コマ 192x208 から半分の
// 96x104 に縮めて持つ（帯では高さ 32px で出すため、Retina の2倍でも足りる）。DOM と時刻の進め方は呼び出し側から渡せるようにする。
// 車は左から右へ走り抜けるだけにする（利用者の指示）。右向きの走る行と、止まってハザードを点ける行だけを持つ。

export const PET_CELL = { width: 96, height: 104 };
export const PET_COLUMNS = 8;
export const PET_ROWS = 5;
export const PET_MAX = 6;

const repeat = (ms, count, last) => [...Array(count - 1).fill(ms), last];
// 行と1コマずつの表示時間は Codex のペットの決まり（hatch-pet の animation-rows）に合わせる
export const PET_ANIMATIONS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, durations: repeat(120, 8, 220) },
  'running-left': { row: 2, durations: repeat(120, 8, 220) },
  waving: { row: 3, durations: repeat(140, 4, 280) },
  jumping: { row: 4, durations: repeat(140, 5, 280) },
};

// 車の絵。1コマ 128x64、4列 x 2行。走る行はタイヤを回し、ハザードの行は点いた絵と消えた絵の2コマ
export const CAR_ANIMATIONS = {
  drive: { row: 0, durations: [70, 70, 70, 70] },
  hazard: { row: 1, durations: [450, 450] },
};

// ペットの種類。motion は動かし方（wander: 左右に気ままに動く、drive: 左から右へ走り抜ける）
export const PET_KINDS = {
  cat: { sheet: 'pets/cat/spritesheet.webp', cell: PET_CELL, columns: PET_COLUMNS, rows: PET_ROWS, animations: PET_ANIMATIONS, motion: 'wander', height: 32 },
  dog: { sheet: 'pets/dog/spritesheet.webp', cell: PET_CELL, columns: PET_COLUMNS, rows: PET_ROWS, animations: PET_ANIMATIONS, motion: 'wander', height: 32 },
  car: { sheet: 'pets/car/spritesheet.webp', cell: { width: 128, height: 64 }, columns: 4, rows: 2, animations: CAR_ANIMATIONS, motion: 'drive', height: 36 },
};

// 終わった直後はその場で跳ねる時間
export const DONE_JUMP_MS = 3000;
// 1回跳ねる時間（跳ねる行のコマの合計）
export const HOP_MS = PET_ANIMATIONS.jumping.durations.reduce((a, b) => a + b, 0);
// 速さ（表示の px / ms）と、走る行のコマ送りの速さの倍率。普段は歩く・走るを気ままに繰り返し、考え中は全力で走る
export const PET_SPEEDS = { walk: 0.035, run: 0.09, dash: 0.13 };
const FRAME_RATE = { walk: 0.6, run: 1, dash: 1.3 };
// 車の速さ（表示の px / ms）。猫・犬より速く走り抜け、考え中はさらに速くする
export const CAR_SPEEDS = { cruise: 0.15, fast: 0.4 };
// 何もしていないときの気ままな動き。重みと続く時間（ms）
export const WANDER_MOODS = [
  { mood: 'walk', weight: 4, min: 2000, max: 5000 },
  { mood: 'run', weight: 3, min: 1000, max: 3000 },
  { mood: 'stand', weight: 2, min: 1000, max: 3000 },
  { mood: 'hop', weight: 1.5, min: HOP_MS, max: HOP_MS },
];
// 考え中にときどき跳ねる割合（1ms あたり）
const DASH_HOP_RATE = 1 / 2500;
// 走りながら跳ねる高さ（表示の px）。正面向きの跳ねる絵は使わず、横向きの絵のまま弧を描かせる
// （2026-11-18 利用者の指摘。走る途中で正面を向いて跳ねるのが気持ち悪かった）。正面向きの絵は、終わったときのお祝いだけに使う
export const HOP_HEIGHT = 7;

// エージェントの状態から動きを選ぶ（2026-11-18 利用者の指示で、普段から走り回る形にした）。
// 考え中は全力で走る、許可待ちは立ち止まって手を振る、終わった直後は跳ねる、それ以外は気ままに歩き回る
export function petAction(state, { doneAt = 0, now = Date.now() } = {}) {
  if (state === 'working') return 'dash';
  if (state === 'waiting') return 'waving';
  if (state === 'done' && now - doneAt < DONE_JUMP_MS) return 'jumping';
  return 'wander';
}

function pickMood(random) {
  const total = WANDER_MOODS.reduce((sum, m) => sum + m.weight, 0);
  let roll = random() * total;
  const choice = WANDER_MOODS.find((m) => (roll -= m.weight) < 0) || WANDER_MOODS[0];
  return { mood: choice.mood, left: choice.min + random() * (choice.max - choice.min) };
}

// 1匹ぶんを、経過時間だけ進める。位置は 0〜width の範囲で、端に着いたら折り返す。random は試験で差し替える
export function stepPet(pet, { action, width, dt, reduceMotion = false, random = Math.random }) {
  const next = { mood: 'stand', moodLeft: 0, hopLeft: 0, ...pet };
  let gait = null;
  if (reduceMotion) {
    // 動きを減らす設定では、動かずに状態の絵だけを出す
    next.hopLeft = 0;
  } else if (action === 'wander') {
    next.moodLeft -= dt;
    if (next.moodLeft <= 0) {
      const picked = pickMood(random);
      next.mood = picked.mood;
      next.moodLeft = picked.left;
      if (random() < 0.3) next.dir = -next.dir;
      if (picked.mood === 'hop') next.hopLeft = HOP_MS;
    }
    if (next.mood === 'walk' || next.mood === 'run') gait = next.mood;
    // 気ままに跳ねるときは、走る速さで前へ跳ぶ
    if (next.mood === 'hop') gait = 'run';
  } else if (action === 'dash') {
    gait = 'dash';
    if (next.hopLeft <= 0 && random() < dt * DASH_HOP_RATE) next.hopLeft = HOP_MS;
  } else next.hopLeft = 0;
  if (gait && width > 0) {
    next.x += next.dir * PET_SPEEDS[gait] * dt;
    if (next.x <= 0) { next.x = 0; next.dir = 1; }
    if (next.x >= width) { next.x = width; next.dir = -1; }
  }
  next.x = Math.max(0, Math.min(width, next.x));
  const hopping = next.hopLeft > 0 && !reduceMotion;
  if (hopping) next.hopLeft = Math.max(0, next.hopLeft - dt);
  // 跳ねている間は、残りの時間から弧の高さを出す
  next.lift = hopping && next.hopLeft > 0 ? HOP_HEIGHT * Math.sin(Math.PI * (1 - next.hopLeft / HOP_MS)) : 0;
  const animation = action === 'waving' ? 'waving'
    : action === 'jumping' ? 'jumping'
    : gait ? (next.dir > 0 ? 'running-right' : 'running-left')
    : 'idle';
  return advanceFrame(next, PET_ANIMATIONS, animation, dt * (gait ? FRAME_RATE[gait] : 1), reduceMotion);
}

function advanceFrame(next, animations, animation, dt, reduceMotion) {
  if (animation !== next.animation) {
    next.animation = animation;
    next.frame = 0;
    next.elapsed = 0;
  } else if (!reduceMotion) {
    const { durations } = animations[animation];
    next.elapsed += dt;
    while (next.elapsed >= durations[next.frame]) {
      next.elapsed -= durations[next.frame];
      next.frame = (next.frame + 1) % durations.length;
    }
  }
  return next;
}

// 車を1台ぶん進める。左から右へ走り、右の端から出きったら左の外から入り直す。size は車の表示の幅（px）。
// 許可待ちは帯の中に入りきったところで止まり、ハザードを点ける。帯の外で止まると見えないため、入りきるまでは走らせる
export function stepCar(car, { action, width, size, dt, reduceMotion = false }) {
  const next = { ...car, dir: 1, lift: 0, hopLeft: 0 };
  const inside = next.x >= 0 && next.x <= width;
  const stopped = action === 'waving' && inside;
  const speed = stopped ? 0 : action === 'dash' ? CAR_SPEEDS.fast : CAR_SPEEDS.cruise;
  if (!reduceMotion && width > 0) next.x += speed * dt;
  if (next.x > width + size) next.x = -size;
  const animation = action === 'waving' ? 'hazard' : 'drive';
  // タイヤの回る速さは走る速さに合わせ、止まっている間は回さない
  const rate = animation === 'hazard' ? 1 : speed / CAR_SPEEDS.cruise;
  return advanceFrame(next, CAR_ANIMATIONS, animation, dt * rate, reduceMotion);
}

// すれ違った猫どうしは、後ろから来たほうが跳ねる。before と after は同じ並びの位置
export function crossings(before, after) {
  const hops = new Set();
  for (let i = 0; i < after.length; i++) {
    for (let j = i + 1; j < after.length; j++) {
      if (Math.sign(before[i] - before[j]) * Math.sign(after[i] - after[j]) < 0) hops.add(j);
    }
  }
  return hops;
}

// 背景の位置。height は表示の高さ（px）
export function spritePosition(kind, animation, frame, height) {
  const { cell, columns, rows } = kind;
  const scale = height / cell.height;
  const { row } = kind.animations[animation];
  return { x: -frame * cell.width * scale, y: -row * cell.height * scale,
    width: cell.width * scale, sheetWidth: columns * cell.width * scale, sheetHeight: rows * cell.height * scale };
}

export function createPetBar(host, { kinds = PET_KINDS, onPick, now = () => performance.now(), reduceMotion = () => false }) {
  const pets = new Map();
  let frame = null;
  let last = null;
  let items = [];
  let kindName = 'cat';
  let kind = kinds.cat;

  function element(item) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pet';
    el.dataset.kind = kindName;
    el.style.backgroundImage = `url("${kind.sheet}")`;
    el.addEventListener('click', () => onPick?.(item.id));
    host.append(el);
    return el;
  }

  function draw(pet, item) {
    const p = spritePosition(kind, pet.animation, pet.frame, kind.height);
    pet.el.style.width = `${p.width}px`;
    pet.el.style.height = `${kind.height}px`;
    pet.el.style.backgroundSize = `${p.sheetWidth}px ${p.sheetHeight}px`;
    pet.el.style.backgroundPosition = `${p.x}px ${p.y}px`;
    pet.el.style.transform = `translate(${Math.round(pet.x)}px, ${-Math.round(pet.lift || 0)}px)`;
    pet.el.dataset.action = pet.action;
    pet.el.dataset.animation = pet.animation;
    pet.el.title = item.label;
    pet.el.setAttribute('aria-label', item.label);
  }

  function tick() {
    frame = null;
    const t = now();
    const dt = last === null ? 0 : Math.min(200, t - last);
    last = t;
    const size = kind.cell.width * kind.height / kind.cell.height;
    const width = Math.max(0, host.clientWidth - size);
    const reduce = reduceMotion();
    const before = items.map((item) => pets.get(item.id).x);
    for (const item of items) {
      const pet = pets.get(item.id);
      const action = petAction(item.state, { doneAt: item.doneAt, now: Date.now() });
      const moved = kind.motion === 'drive'
        ? stepCar(pet, { action, width, size, dt, reduceMotion: reduce })
        : stepPet(pet, { action, width, dt, reduceMotion: reduce });
      Object.assign(pet, moved, { action });
    }
    // 車は同じ向きに走るため、追い抜いても跳ねさせない
    if (!reduce && kind.motion === 'wander') {
      for (const index of crossings(before, items.map((item) => pets.get(item.id).x))) {
        const pet = pets.get(items[index].id);
        if (pet.action === 'wander' || pet.action === 'dash') pet.hopLeft = HOP_MS;
      }
    }
    for (const item of items) draw(pets.get(item.id), item);
    // 座っている間も息をする動きがあるため、出ている間は描き続ける。窓が隠れたら止め、見えたら動かし直す
    if (!reduce && !document.hidden && items.length) frame = requestAnimationFrame(tick);
  }

  function schedule() {
    if (frame === null) {
      last = null;
      frame = requestAnimationFrame(tick);
    }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });

  return {
    // items: [{ id, state, label, doneAt }]。並びは左の一覧の順。最大 PET_MAX 匹。kindName は cat・dog・car
    update(next, name = 'cat') {
      const nextName = kinds[name] ? name : 'cat';
      // 種類を替えたら、絵も動かし方も違うため、出ているペットを全部出し直す
      if (nextName !== kindName) {
        for (const pet of pets.values()) pet.el.remove();
        pets.clear();
        kindName = nextName;
        kind = kinds[kindName];
      }
      items = next.slice(0, PET_MAX);
      // 隠れたままでは幅が測れず、出てくる場所が左端に寄るため、先に出す
      host.hidden = items.length === 0;
      const ids = new Set(items.map((item) => item.id));
      for (const [id, pet] of pets) {
        if (!ids.has(id)) { pet.el.remove(); pets.delete(id); }
      }
      items.forEach((item, i) => {
        if (pets.has(item.id)) return;
        // 出てくる場所は、並びの順にずらして重なりにくくする
        const start = (host.clientWidth || 0) * ((i + 0.5) / PET_MAX);
        pets.set(item.id, { el: element(item), x: start, dir: i % 2 ? -1 : 1, animation: null, frame: 0, elapsed: 0, action: 'wander', mood: 'stand', moodLeft: 0, hopLeft: 0 });
      });
      schedule();
    },
    pets: () => [...pets.entries()].map(([id, pet]) => ({ id, kind: pet.el.dataset.kind, x: pet.x, lift: pet.lift || 0, action: pet.action, mood: pet.mood, animation: pet.animation, frame: pet.frame })),
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const pet of pets.values()) pet.el.remove();
      pets.clear();
    },
  };
}
