// 上の帯のペット。エージェントを動かしている端末1つにつき1匹（最大6匹）。押すとその端末へ移る。
// 猫・犬は普段は気ままに歩き回り、考え中は全力で走り、許可待ちは立ち止まって手を振り、終わった直後は跳ねる。
// 車は左から右へ走り抜け、考え中は速く、許可待ちは止まってハザードを点ける。
use crate::agent::AgentState;
use crate::app::{Mark, Palette, TerpApp, mark_of};
use gpui::{AnyElement, ClickEvent, Context, MouseButton, ObjectFit, SharedString, Task, Window, canvas, div, img, prelude::*, px};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

pub const PET_MAX: usize = 6;
const DONE_JUMP: Duration = Duration::from_millis(3000);
const HOP_HEIGHT: f32 = 7.0;
const TICK_MS: u64 = 60;

struct Kind {
    sheet: &'static str,
    cell: (f32, f32),
    columns: f32,
    rows: f32,
    height: f32,
    car: bool,
}

fn kind(name: &str) -> Kind {
    match name {
        "dog" => Kind { sheet: "pets/dog/spritesheet.webp", cell: (96.0, 104.0), columns: 8.0, rows: 5.0, height: 32.0, car: false },
        "car" => Kind { sheet: "pets/car/spritesheet.webp", cell: (128.0, 64.0), columns: 4.0, rows: 2.0, height: 36.0, car: true },
        _ => Kind { sheet: "pets/cat/spritesheet.webp", cell: (96.0, 104.0), columns: 8.0, rows: 5.0, height: 32.0, car: false },
    }
}

// 行と1コマずつの表示時間（ms）
fn animation(name: &str) -> (usize, &'static [u64]) {
    match name {
        "run-right" => (1, &[120, 120, 120, 120, 120, 120, 120, 220]),
        "run-left" => (2, &[120, 120, 120, 120, 120, 120, 120, 220]),
        "wave" => (3, &[140, 140, 140, 280]),
        "jump" => (4, &[140, 140, 140, 140, 280]),
        "drive" => (0, &[70, 70, 70, 70]),
        "hazard" => (1, &[450, 450]),
        _ => (0, &[280, 110, 110, 140, 140, 320]),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mood {
    Walk,
    Run,
    Stand,
    Hop,
}

pub struct Pet {
    x: f32,
    dir: f32,
    mood: Mood,
    mood_until: Instant,
    anim: &'static str,
    frame: usize,
    frame_left: f32,
    hop_started: Option<Instant>,
    done_until: Option<Instant>,
    last_mark: Mark,
}

pub struct Pets {
    pub pets: HashMap<u64, Pet>,
    pub width: Rc<Cell<f32>>,
    pub kind: String,
    seed: u64,
    last: Instant,
    _tick: Option<Task<()>>,
}

impl Default for Pets {
    fn default() -> Self {
        Pets { pets: HashMap::new(), width: Rc::new(Cell::new(240.0)), kind: String::new(), seed: 0x9e3779b97f4a7c15, last: Instant::now(), _tick: None }
    }
}

impl Pets {
    fn rand(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed % 10_000) as f32 / 10_000.0
    }

    fn pick_mood(&mut self) -> (Mood, Duration) {
        let r = self.rand() * 10.5;
        let (mood, min, max) = if r < 4.0 {
            (Mood::Walk, 2000.0, 5000.0)
        } else if r < 7.0 {
            (Mood::Run, 1000.0, 3000.0)
        } else if r < 9.0 {
            (Mood::Stand, 1000.0, 3000.0)
        } else {
            (Mood::Hop, 980.0, 980.0)
        };
        (mood, Duration::from_millis((min + self.rand() * (max - min)) as u64))
    }
}

impl TerpApp {
    // エージェントを動かしている端末（左の一覧の順に最大6つ）
    fn pet_targets(&self, cx: &gpui::App) -> Vec<(u64, Mark)> {
        self.list_order(cx)
            .into_iter()
            .filter_map(|id| self.session(id).map(|s| (id, s.view.read(cx))))
            .filter(|(_, v)| v.is_agent())
            .map(|(id, v)| (id, mark_of(v)))
            .take(PET_MAX)
            .collect()
    }

    pub(crate) fn update_pets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let config = cx.global::<crate::appearance::Appearance>().config.clone();
        let targets = if config.pets { self.pet_targets(cx) } else { Vec::new() };
        if self.pets.kind != config.pet_kind {
            self.pets.kind = config.pet_kind.clone();
            self.pets.pets.clear();
        }
        let now = Instant::now();
        let dt = now.duration_since(self.pets.last).as_secs_f32() * 1000.0;
        self.pets.last = now;
        let width = self.pets.width.get().max(60.0);
        let k = kind(&self.pets.kind);
        let pet_w = k.cell.0 * k.height / k.cell.1;
        self.pets.pets.retain(|id, _| targets.iter().any(|(t, _)| t == id));
        for (id, mark) in &targets {
            if !self.pets.pets.contains_key(id) {
                let x = if k.car { -pet_w - self.pets.rand() * width } else { self.pets.rand() * (width - pet_w).max(1.0) };
                let dir = if self.pets.rand() < 0.5 { -1.0 } else { 1.0 };
                self.pets.pets.insert(
                    *id,
                    Pet { x, dir, mood: Mood::Walk, mood_until: now, anim: "idle", frame: 0, frame_left: 0.0, hop_started: None, done_until: None, last_mark: *mark },
                );
            }
            let mut mood_pick = None;
            if self.pets.pets[id].mood_until <= now {
                mood_pick = Some(self.pets.pick_mood());
            }
            let hop_roll = self.pets.rand();
            let pet = self.pets.pets.get_mut(id).expect("足した");
            // 考え中から終わったに替わったら、その場で跳ねる
            if pet.last_mark != *mark {
                if matches!(mark, Mark::Agent(AgentState::Done)) {
                    pet.done_until = Some(now + DONE_JUMP);
                }
                pet.last_mark = *mark;
            }
            let working = matches!(mark, Mark::Agent(AgentState::Working));
            let waiting = matches!(mark, Mark::Agent(AgentState::Waiting));
            let celebrating = pet.done_until.is_some_and(|t| t > now);
            let (anim, speed): (&'static str, f32) = if k.car {
                let stopped = waiting && pet.x >= 0.0 && pet.x + pet_w <= width;
                if stopped { ("hazard", 0.0) } else { ("drive", if working { 0.4 } else { 0.15 }) }
            } else if celebrating {
                ("jump", 0.0)
            } else if waiting {
                ("wave", 0.0)
            } else {
                if let Some((mood, len)) = mood_pick {
                    pet.mood = mood;
                    pet.mood_until = now + len;
                    if mood == Mood::Hop {
                        pet.hop_started = Some(now);
                    }
                }
                // 考え中はときどき跳ねる
                if working && pet.hop_started.is_none() && hop_roll < dt / 2500.0 {
                    pet.hop_started = Some(now);
                }
                let speed = if working {
                    0.13
                } else {
                    match pet.mood {
                        Mood::Walk => 0.035,
                        Mood::Run | Mood::Hop => 0.09,
                        Mood::Stand => 0.0,
                    }
                };
                if speed == 0.0 { ("idle", 0.0) } else if pet.dir > 0.0 { ("run-right", speed) } else { ("run-left", speed) }
            };
            pet.x += speed * if k.car { 1.0 } else { pet.dir } * dt;
            if k.car {
                if pet.x > width {
                    pet.x = -pet_w;
                }
            } else if pet.x < 0.0 {
                pet.x = 0.0;
                pet.dir = 1.0;
            } else if pet.x > width - pet_w {
                pet.x = (width - pet_w).max(0.0);
                pet.dir = -1.0;
            }
            if pet.hop_started.is_some_and(|t| now.duration_since(t) > Duration::from_millis(840)) {
                pet.hop_started = None;
            }
            if pet.anim != anim {
                pet.anim = anim;
                pet.frame = 0;
                pet.frame_left = 0.0;
            }
            let (_, durations) = animation(anim);
            let rate = if speed > 0.0 && !k.car { speed / 0.09 } else if k.car && anim == "drive" { speed / 0.15 } else { 1.0 };
            pet.frame_left -= dt * rate;
            while pet.frame_left <= 0.0 {
                pet.frame = (pet.frame + 1) % durations.len();
                pet.frame_left += durations[pet.frame] as f32;
            }
        }
        // 動かすペットがいて、窓が出ている間だけ時計を回す
        let want = !self.pets.pets.is_empty() && window.is_window_active();
        if want && self.pets._tick.is_none() {
            self.pets.last = Instant::now();
            self.pets._tick = Some(cx.spawn_in(window, async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(TICK_MS)).await;
                    if this.update_in(cx, |app, window, cx| {
                        app.update_pets(window, cx);
                        cx.notify();
                    })
                    .is_err()
                    {
                        break;
                    }
                }
            }));
        } else if !want {
            self.pets._tick = None;
        }
    }

    pub(crate) fn render_pets(&self, _p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let config = &cx.global::<crate::appearance::Appearance>().config;
        if !config.pets || self.pets.pets.is_empty() {
            return None;
        }
        let k = kind(&self.pets.kind);
        let scale = k.height / k.cell.1;
        let (pw, ph) = (k.cell.0 * scale, k.height);
        let width_cell = self.pets.width.clone();
        let scene = config.pet_scene.clone();
        let mut strip = div()
            .id("pets")
            .relative()
            .flex_1()
            .min_w(px(80.0))
            .h_full()
            .overflow_hidden()
            .child(canvas(move |bounds, _, _| width_cell.set(f32::from(bounds.size.width)), |_, _, _, _| {}).absolute().size_full());
        if scene != "none" {
            // 1600x80 の絵を高さに合わせて横に並べる
            let h = 38.0;
            let w = 1600.0 * h / 80.0;
            for i in 0..2 {
                strip = strip.child(
                    img(SharedString::from(format!("pets/scenes/{scene}.webp")))
                        .absolute()
                        .left(px(i as f32 * w))
                        .top_0()
                        .w(px(w))
                        .h(px(h))
                        .object_fit(ObjectFit::Fill)
                        .opacity(0.85),
                );
            }
        }
        let now = Instant::now();
        for (id, pet) in &self.pets.pets {
            let (row, _) = animation(pet.anim);
            let lift = pet.hop_started.map(|t| {
                let f = (now.duration_since(t).as_secs_f32() / 0.84).clamp(0.0, 1.0);
                (f * std::f32::consts::PI).sin() * HOP_HEIGHT
            });
            let id = *id;
            strip = strip.child(
                div()
                    .id(("pet", id))
                    .absolute()
                    .left(px(pet.x))
                    .bottom(px(1.0 + lift.unwrap_or(0.0)))
                    .w(px(pw))
                    .h(px(ph))
                    .overflow_hidden()
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
                    .child(
                        img(SharedString::from(k.sheet))
                            .absolute()
                            .left(px(-(pet.frame as f32) * pw))
                            .top(px(-(row as f32) * ph))
                            .w(px(pw * k.columns))
                            .h(px(ph * k.rows))
                            .object_fit(ObjectFit::Fill),
                    ),
            );
        }
        Some(strip.into_any_element())
    }
}
