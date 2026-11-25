// 設定の「AI で好みを作成」。8つの質問に答えて AI にテーマを作らせ、見本を見て直させてから適用する
use crate::app::{Palette, TerpApp};
use crate::appearance::Appearance;
use crate::config::Rgb;
use crate::input::{InputEvent, TextInput};
use crate::themegen::{Answers, Generated};
use gpui::{AnyElement, ClickEvent, Context, Entity, FontWeight, MouseButton, SharedString, Subscription, Window, deferred, div, prelude::*, px};
use serde_json::Value;

const MOODS: [&str; 6] = ["桜", "海", "森", "夕焼け", "モノクロ", "ネオン"];

pub struct ThemeAi {
    brightness: usize,
    moods: [bool; 6],
    mood_text: Entity<TextInput>,
    contrast: usize,
    temperature: usize,
    saturation: usize,
    use_accent: bool,
    accent: Entity<TextInput>,
    colorblind: bool,
    app_background: bool,
    base: usize,
    // 1回目に作ったときの答え。直すときも同じ答えを渡す
    answers: Option<Answers>,
    generated: Option<Generated>,
    saved: Option<String>,
    instruction: Entity<TextInput>,
    busy: bool,
    status: String,
    error: Option<String>,
    request: u64,
    _subscriptions: Vec<Subscription>,
}

const BRIGHTNESS: [&str; 2] = ["暗い", "明るい"];
const CONTRAST: [&str; 3] = ["やわらかい", "ふつう", "くっきり"];
const TEMPERATURE: [&str; 3] = ["暖かい", "ふつう", "冷たい"];
const SATURATION: [&str; 3] = ["落ち着いた", "ふつう", "鮮やか"];
const BASE: [&str; 2] = ["新しく作る", "今のテーマを土台にする"];

impl TerpApp {
    pub(crate) fn open_theme_ai(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.theme_ai.is_some() {
            return;
        }
        let mood_text = cx.new(|cx| TextInput::new("例: 深い青に、少しだけ金色", cx));
        let accent = cx.new(|cx| {
            let mut i = TextInput::new("#rrggbb", cx);
            i.set_text("#58c4ff", cx);
            i
        });
        let instruction = cx.new(|cx| TextInput::new("例: もう少し青く", cx));
        let mut subs = Vec::new();
        for input in [&mood_text, &accent] {
            subs.push(cx.subscribe_in(input, window, |app, _, event: &InputEvent, window, cx| match event {
                InputEvent::Submit { .. } => app.theme_ai_generate(false, window, cx),
                InputEvent::Cancel => app.close_theme_ai(cx),
                _ => {}
            }));
        }
        subs.push(cx.subscribe_in(&instruction, window, |app, _, event: &InputEvent, window, cx| match event {
            InputEvent::Submit { .. } => app.theme_ai_generate(true, window, cx),
            InputEvent::Cancel => app.close_theme_ai(cx),
            _ => cx.notify(),
        }));
        self.theme_ai = Some(ThemeAi {
            brightness: 0,
            moods: [false; 6],
            mood_text,
            contrast: 1,
            temperature: 1,
            saturation: 1,
            use_accent: false,
            accent,
            colorblind: false,
            app_background: false,
            base: 0,
            answers: None,
            generated: None,
            saved: None,
            instruction,
            busy: false,
            status: String::new(),
            error: None,
            request: 0,
            _subscriptions: subs,
        });
        cx.notify();
    }

    pub(crate) fn close_theme_ai(&mut self, cx: &mut Context<Self>) {
        if self.theme_ai.take().is_some() {
            cx.notify();
        }
    }

    fn theme_ai_answers(&self, cx: &Context<Self>) -> Result<Answers, String> {
        let t = self.theme_ai.as_ref().ok_or("閉じています")?;
        let mut mood: Vec<String> = MOODS.iter().zip(t.moods).filter(|(_, on)| *on).map(|(m, _)| m.to_string()).collect();
        let text = t.mood_text.read(cx).text().trim().to_string();
        if !text.is_empty() {
            mood.push(text.chars().take(400).collect());
        }
        let accent = if t.use_accent {
            let value = t.accent.read(cx).text().trim().to_lowercase();
            if Rgb::parse(&value).is_none() || !value.starts_with('#') {
                return Err("強調色は #rrggbb の形で書いてください".into());
            }
            Some(value)
        } else {
            None
        };
        Ok(Answers {
            brightness: BRIGHTNESS[t.brightness].into(),
            mood: mood.join("、"),
            contrast: CONTRAST[t.contrast].into(),
            temperature: TEMPERATURE[t.temperature].into(),
            saturation: SATURATION[t.saturation].into(),
            accent,
            colorblind: t.colorblind,
            app_background: t.app_background,
            base: if t.base == 0 { "new".into() } else { "current".into() },
        })
    }

    fn theme_ai_generate(&mut self, revising: bool, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(t) = self.theme_ai.as_ref() else { return };
        if t.busy {
            return;
        }
        let instruction = t.instruction.read(cx).text().trim().to_string();
        let revising = revising && t.generated.is_some();
        if revising && instruction.is_empty() {
            return;
        }
        let answers = match t.answers.clone() {
            Some(a) if revising => a,
            _ => match self.theme_ai_answers(cx) {
                Ok(a) => a,
                Err(e) => {
                    if let Some(t) = self.theme_ai.as_mut() {
                        t.error = Some(e);
                    }
                    cx.notify();
                    return;
                }
            },
        };
        let config = cx.global::<Appearance>().config.clone();
        let current = if revising { t.generated.clone() } else { None };
        let base = (!revising && answers.base == "current").then(|| crate::themegen::base_colors(&cx.global::<Appearance>().theme));
        let t = self.theme_ai.as_mut().expect("開いている");
        if !revising {
            t.generated = None;
            t.saved = None;
        }
        t.answers = Some(answers.clone());
        t.busy = true;
        t.error = None;
        t.status = if revising { "修正中…".into() } else { "作成中…".into() };
        t.request += 1;
        let token = t.request;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let instruction = revising.then_some(instruction);
                    crate::themegen::generate(&config, &answers, current.as_ref(), instruction.as_deref(), base)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                let Some(t) = app.theme_ai.as_mut() else { return };
                if t.request != token {
                    return;
                }
                t.busy = false;
                t.status.clear();
                match result {
                    Ok(theme) => {
                        t.generated = Some(theme);
                        t.saved = None;
                        t.instruction.update(cx, |i, cx| i.set_text("", cx));
                    }
                    Err(e) => {
                        t.error = Some(e);
                        if !revising {
                            t.answers = None;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn theme_ai_apply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(t) = self.theme_ai.as_mut() else { return };
        let Some(theme) = t.generated.clone() else { return };
        if t.busy {
            return;
        }
        let name = match t.saved.clone() {
            Some(name) => name,
            None => match crate::themegen::save(&theme) {
                Ok(name) => {
                    t.saved = Some(name.clone());
                    name
                }
                Err(e) => {
                    t.error = Some(e);
                    cx.notify();
                    return;
                }
            },
        };
        let with_accent = t.answers.as_ref().is_some_and(|a| a.accent.is_some());
        let mut result = crate::settings::write_config("theme", Some(Value::String(name.clone())));
        // AI が作ったアプリの背景色は、このテーマのときだけ使う
        if result.is_ok() {
            if let Some(bg) = &theme.app_background {
                result = crate::settings::write_config("appBackground", Some(Value::String(bg.clone())))
                    .and_then(|_| crate::settings::write_config("appBackgroundTheme", Some(Value::String(name.clone()))));
            }
        }
        if result.is_ok() && with_accent {
            result = crate::settings::write_config("accent", None);
        }
        if let Err(e) = result {
            if let Some(t) = self.theme_ai.as_mut() {
                t.error = Some(format!("テーマを保存できませんでした: {e}"));
            }
            cx.notify();
            return;
        }
        if let Some(s) = self.settings.as_mut() {
            s.reload_themes();
        }
        self.theme_ai = None;
        self.reload_appearance_now(window, cx);
        cx.notify();
    }

    pub(crate) fn render_theme_ai(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.theme_ai.as_ref()?;
        let locked = t.busy || t.generated.is_some();
        let pill = |id: String, label: &str, on: bool| {
            div()
                .id(SharedString::from(id))
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .px_2()
                .py(px(3.0))
                .rounded_md()
                .border_1()
                .text_sm()
                .border_color(if on { p.accent } else { p.border })
                .when(on, |d| d.bg(p.accent_fill))
                .when(!locked, |d| d.hover(|s| s.bg(p.hover)))
                .child(label.to_string())
        };
        // 1つだけ選ぶ問い
        let single = |key: &'static str, options: &[&'static str], current: usize, cx: &mut Context<Self>| {
            let mut row = div().flex().flex_row().flex_wrap().gap_1();
            for (i, label) in options.iter().enumerate() {
                row = row.child(pill(format!("ai-{key}-{i}"), label, i == current).when(!locked, |d| {
                    d.on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        if let Some(t) = app.theme_ai.as_mut() {
                            match key {
                                "brightness" => t.brightness = i,
                                "contrast" => t.contrast = i,
                                "temperature" => t.temperature = i,
                                "saturation" => t.saturation = i,
                                _ => t.base = i,
                            }
                        }
                        cx.notify();
                    }))
                }));
            }
            row
        };
        let check = |key: &'static str, label: &'static str, on: bool, cx: &mut Context<Self>| {
            pill(format!("ai-{key}"), &format!("{} {label}", if on { "☑" } else { "☐" }), on).when(!locked, |d| {
                d.on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    if let Some(t) = app.theme_ai.as_mut() {
                        match key {
                            "useAccent" => t.use_accent = !t.use_accent,
                            "colorblind" => t.colorblind = !t.colorblind,
                            _ => t.app_background = !t.app_background,
                        }
                    }
                    cx.notify();
                }))
            })
        };
        let question = |title: &str, body: gpui::Div| div().flex().flex_col().gap_1().child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title.to_string())).child(body);
        let input_box = |input: Entity<TextInput>, width: Option<f32>| {
            div()
                .when_some(width, |d, w| d.w(px(w)))
                .when(width.is_none(), |d| d.w_full())
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(p.border)
                .bg(p.term_bg)
                .text_sm()
                .child(input)
        };
        let mut moods = div().flex().flex_row().flex_wrap().gap_1();
        for (i, m) in MOODS.iter().enumerate() {
            let on = t.moods[i];
            moods = moods.child(pill(format!("ai-mood-{i}"), &format!("{} {m}", if on { "☑" } else { "☐" }), on).when(!locked, |d| {
                d.on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    if let Some(t) = app.theme_ai.as_mut() {
                        t.moods[i] = !t.moods[i];
                    }
                    cx.notify();
                }))
            }));
        }
        let accent_swatch = Rgb::parse(t.accent.read(cx).text()).map(|c| crate::appearance::hsla(c, 1.0));
        let questions = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(locked, |d| d.opacity(0.6))
            .child(question("1. 明るさ", single("brightness", &BRIGHTNESS, t.brightness, cx)))
            .child(question(
                "2. 好きな色や雰囲気",
                div().flex().flex_col().gap_1().child(moods).child(div().text_xs().text_color(p.muted).child("自由に書く・書き足す")).child(input_box(t.mood_text.clone(), None)),
            ))
            .child(question("3. くっきり具合", single("contrast", &CONTRAST, t.contrast, cx)))
            .child(question("4. 色の温度", single("temperature", &TEMPERATURE, t.temperature, cx)))
            .child(question("5. 鮮やかさ", single("saturation", &SATURATION, t.saturation, cx)))
            .child(question(
                "6. 強調色",
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(check("useAccent", "強調色を指定する", t.use_accent, cx))
                    .when(t.use_accent, |d| {
                        d.when_some(accent_swatch, |d, c| d.child(div().size(px(18.0)).rounded_sm().border_1().border_color(p.border).bg(c)))
                            .child(input_box(t.accent.clone(), Some(110.0)))
                    }),
            ))
            .child(question(
                "7. 見やすさ",
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap_1()
                    .child(check("colorblind", "赤と緑を見分けやすくする", t.colorblind, cx))
                    .child(check("appBackground", "アプリの背景色（左の一覧など）も作る", t.app_background, cx)),
            ))
            .child(question("8. 土台", single("base", &BASE, t.base, cx)));
        let preview = t.generated.as_ref().map(|g| {
            let theme = g.theme();
            let config = &cx.global::<Appearance>().config;
            let accent = if t.answers.as_ref().is_some_and(|a| a.accent.is_some()) { None } else { config.accent.as_deref().and_then(Rgb::parse) };
            let chrome = crate::config::chrome_colors(&theme, accent);
            TerpApp::theme_sample(&theme, &chrome, &g.name, cx)
        });
        let button = |id: &'static str, label: &str, primary: bool, enabled: bool| {
            div()
                .id(id)
                .px_3()
                .py_1()
                .rounded_md()
                .text_sm()
                .when(primary, |d| d.bg(p.accent).text_color(p.solid_bg))
                .when(!primary, |d| d.border_1().border_color(p.border))
                .when(!enabled, |d| d.opacity(0.5))
                .when(enabled && !primary, |d| d.hover(|s| s.bg(p.hover)))
                .child(label.to_string())
        };
        let has_result = t.generated.is_some();
        let can_refine = has_result && !t.busy && !t.instruction.read(cx).text().trim().is_empty();
        let mut actions = div().flex().flex_row().justify_end().gap_2().child(
            button("ai-cancel", "やめる", false, true).on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.close_theme_ai(cx))),
        );
        if has_result {
            actions = actions
                .child(button("ai-retry", "作り直す", false, !t.busy).when(!t.busy, |d| d.on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.theme_ai_generate(false, w, cx)))))
                .child(button("ai-apply", "適用", true, !t.busy).when(!t.busy, |d| d.on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.theme_ai_apply(w, cx)))));
        } else {
            let label = if t.busy { "作成中…" } else if t.error.is_some() { "もう一度" } else { "作成" };
            actions = actions.child(button("ai-create", label, true, !t.busy).when(!t.busy, |d| d.on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.theme_ai_generate(false, w, cx)))));
        }
        let panel = div()
            .id("theme-ai")
            .occlude()
            .w(px(600.0))
            .max_h(gpui::relative(0.85))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded_lg()
            .border_1()
            .border_color(p.border)
            .bg(p.solid_bg)
            .text_color(p.text)
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("AI で好みを作成"))
            .child(questions)
            .when(!t.status.is_empty(), |d| d.child(div().text_sm().text_color(p.muted).child(t.status.clone())))
            .when_some(t.error.clone(), |d, e| d.child(div().text_sm().text_color(p.warning).child(e)))
            .when_some(t.generated.as_ref().and_then(|g| g.concept.clone()), |d, c| d.child(div().text_sm().text_color(p.muted).child(c)))
            .children(preview)
            .when(has_result, |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("直したいこと（200字以内）"))
                        .child(input_box(t.instruction.clone(), None))
                        .child(
                            div().flex().child(
                                button("ai-refine", "この案を直す", false, can_refine)
                                    .when(can_refine, |d| d.on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.theme_ai_generate(true, w, cx)))),
                            ),
                        ),
                )
            })
            .child(actions);
        Some(
            deferred(
                div()
                    .id("theme-ai-backdrop")
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::black().opacity(0.4))
                    .occlude()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(panel),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }
}
