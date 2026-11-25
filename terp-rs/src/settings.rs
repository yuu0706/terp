// 設定の画面（⌘,）。左に項目、右に設定。変えたらすぐ config.json の該当の値だけを書き換える（手で書いた値は残す）。
use crate::app::{Palette, TerpApp};
use crate::appearance::{Appearance, hsla};
use crate::config::{Config, Rgb, config_path, theme_dirs};
use crate::input::{InputEvent, TextInput};
use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, Focusable, FocusHandle, FontWeight, KeyDownEvent, MouseButton, SharedString,
    Subscription, Task, Window, deferred, div, prelude::*, px,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::Duration;

pub const SECTIONS: [&str; 7] = ["外観", "AI エージェント", "AI の手伝い", "コマンド", "通知", "ショートカット", "詳しい設定"];
const SECTION_ICONS: [&str; 7] = ["palette", "robot", "sparkle", "play", "bell", "keyboard", "sliders"];

pub struct Settings {
    pub section: usize,
    inputs: HashMap<&'static str, Entity<TextInput>>,
    theme_filter: Entity<TextInput>,
    shortcut_filter: Entity<TextInput>,
    command_label: Entity<TextInput>,
    command_line: Entity<TextInput>,
    themes: Vec<String>,
    preview: Option<String>,
    capturing: Option<&'static str>,
    capture_focus: FocusHandle,
    pub message: Option<String>,
    pending: HashMap<&'static str, Task<()>>,
    _subscriptions: Vec<Subscription>,
}

// config.json を読み、変えた値だけを差し替えて書く。None はその項目を消す（既定に戻す）。JSON が壊れていたら書かない
pub fn write_config(key: &str, value: Option<Value>) -> Result<(), String> {
    let path = config_path();
    let mut map = match std::fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => Map::new(),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err("config.json を読めません: JSON のオブジェクトではありません".into()),
            Err(err) => return Err(format!("config.json を読めません: {err}")),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(err) => return Err(format!("config.json を読めません: {err}")),
    };
    match value {
        Some(v) => {
            map.insert(key.to_string(), v);
        }
        None => {
            map.remove(key);
        }
    }
    let _ = std::fs::create_dir_all(crate::config::config_dir());
    let body = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("config.json を書けません: {e}"))
}

fn raw_config() -> Map<String, Value> {
    std::fs::read_to_string(config_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

pub fn list_themes() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for dir in theme_dirs() {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            if e.path().is_file()
                && let Some(name) = e.file_name().to_str()
                && !name.starts_with('.')
                && !names.iter().any(|n| n == name)
            {
                names.push(name.to_string());
            }
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    names
}

// 近道の id と、画面に出す名前・区分
pub const SHORTCUT_LABELS: &[(&str, &str, &str)] = &[
    ("new", "新しいターミナル", "ターミナル"),
    ("split-right", "右に分割", "ターミナル"),
    ("close", "タブを閉じる", "ターミナル"),
    ("reopen", "閉じたタブを開き直す", "ターミナル"),
    ("new-work", "新しい作業", "ターミナル"),
    ("clear", "画面を消去", "ターミナル"),
    ("find", "端末の中を探す", "編集"),
    ("find-next", "次を探す", "編集"),
    ("select-all", "すべて選択", "編集"),
    ("recent", "直前のタブ", "移動"),
    ("prev", "前のタブ", "移動"),
    ("next", "次のタブ", "移動"),
    ("next-attention", "次の要対応", "移動"),
    ("overview", "全体の一覧", "移動"),
    ("pane-left", "左の枠", "移動"),
    ("pane-right", "右の枠", "移動"),
    ("pane-up", "上の枠", "移動"),
    ("pane-down", "下の枠", "移動"),
    ("tab-1", "タブ 1", "移動"),
    ("tab-2", "タブ 2", "移動"),
    ("tab-3", "タブ 3", "移動"),
    ("tab-4", "タブ 4", "移動"),
    ("tab-5", "タブ 5", "移動"),
    ("tab-6", "タブ 6", "移動"),
    ("tab-7", "タブ 7", "移動"),
    ("tab-8", "タブ 8", "移動"),
    ("tab-9", "最後のタブ", "移動"),
    ("workspace-1", "ワークスペース 1", "ワークスペース"),
    ("workspace-2", "ワークスペース 2", "ワークスペース"),
    ("workspace-3", "ワークスペース 3", "ワークスペース"),
    ("workspace-4", "ワークスペース 4", "ワークスペース"),
    ("workspace-5", "ワークスペース 5", "ワークスペース"),
    ("workspace-6", "ワークスペース 6", "ワークスペース"),
    ("workspace-7", "ワークスペース 7", "ワークスペース"),
    ("workspace-8", "ワークスペース 8", "ワークスペース"),
    ("workspace-9", "ワークスペース 9", "ワークスペース"),
    ("workspace-next", "次のワークスペース", "ワークスペース"),
    ("workspace-prev", "前のワークスペース", "ワークスペース"),
    ("toggle-sidebar", "左の一覧", "表示"),
    ("toggle-files", "ファイル", "表示"),
    ("toggle-changes", "変更の一覧", "表示"),
    ("toggle-history", "履歴", "表示"),
    ("font-bigger", "文字を大きく", "表示"),
    ("font-smaller", "文字を小さく", "表示"),
    ("font-reset", "文字を元の大きさに", "表示"),
    ("settings", "設定", "terp"),
];

// "Command+Shift+T" を ⇧⌘T のように見せる
pub fn display_accelerator(value: &str) -> String {
    let mut parts: Vec<&str> = value.split('+').collect();
    if value.ends_with("++") {
        parts.truncate(parts.len().saturating_sub(2));
        parts.push("+");
    }
    let key = parts.pop().unwrap_or("");
    let has = |names: &[&str]| parts.iter().any(|p| names.iter().any(|n| p.eq_ignore_ascii_case(n)));
    let mut out = String::new();
    if has(&["Control", "Ctrl"]) {
        out.push('⌃');
    }
    if has(&["Alt", "Option"]) {
        out.push('⌥');
    }
    if has(&["Shift"]) {
        out.push('⇧');
    }
    if has(&["Command", "Cmd", "CmdOrCtrl", "CommandOrControl"]) {
        out.push('⌘');
    }
    let key = match key.to_ascii_lowercase().as_str() {
        "left" => "←".into(),
        "right" => "→".into(),
        "up" => "↑".into(),
        "down" => "↓".into(),
        "enter" | "return" => "↩".into(),
        "tab" => "⇥".into(),
        "space" => "Space".into(),
        "backspace" => "⌫".into(),
        "escape" | "esc" => "Esc".into(),
        _ => key.to_uppercase(),
    };
    out + &key
}

// 押したキーを Electron の書き方にする。修飾キーを含まないものは記録しない
pub fn keystroke_to_accelerator(k: &gpui::Keystroke) -> Option<String> {
    let m = &k.modifiers;
    if !(m.control || m.alt || m.platform) {
        return None;
    }
    let key = match k.key.as_str() {
        "shift" | "control" | "alt" | "platform" | "function" | "" => return None,
        "enter" => "Enter".to_string(),
        "escape" => return None,
        "left" | "right" | "up" | "down" | "tab" | "space" | "backspace" | "delete" | "home" | "end" => {
            let mut c = k.key.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
        other if other.chars().count() == 1 => other.to_uppercase(),
        other if other.starts_with('f') => other.to_uppercase(),
        _ => return None,
    };
    let mut parts = Vec::new();
    if m.control {
        parts.push("Control");
    }
    if m.alt {
        parts.push("Alt");
    }
    if m.shift {
        parts.push("Shift");
    }
    if m.platform {
        parts.push("Command");
    }
    Some(format!("{}+{key}", parts.join("+")))
}

fn same_keys(a: &str, b: &str) -> bool {
    crate::keys::accelerator_to_gpui(a).is_some() && crate::keys::accelerator_to_gpui(a) == crate::keys::accelerator_to_gpui(b)
}

impl TerpApp {
    pub(crate) fn open_settings_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.is_some() {
            return;
        }
        let config = cx.global::<Appearance>().config.clone();
        let mut subs = Vec::new();
        let mut inputs = HashMap::new();
        let text_fields: [(&'static str, String, &str); 6] = [
            ("fontFamily", config.font_family.clone(), "\"JetBrains Mono\", Menlo, monospace"),
            ("accent", config.accent.clone().unwrap_or_default(), "#rrggbb（空ならテーマのカーソルの色）"),
            ("foreground", config.foreground.clone().unwrap_or_default(), "#rrggbb（空ならテーマの色）"),
            ("background", config.background.clone().unwrap_or_default(), "#rrggbb（空ならテーマの色）"),
            ("appBackground", config.app_background.clone().unwrap_or_default(), "#rrggbb（空なら背景色を少し暗く）"),
            ("editor", config.editor.clone(), "例: code -g {file}:{line}:{col}"),
        ];
        for (key, value, placeholder) in text_fields {
            let input = cx.new(|cx| {
                let mut i = TextInput::new(placeholder, cx);
                i.set_text(&value, cx);
                i
            });
            subs.push(cx.subscribe_in(&input, window, move |app, input, event, window, cx| match event {
                InputEvent::Changed => app.schedule_text_save(key, input.clone(), window, cx),
                InputEvent::Submit { .. } => app.save_text_field(key, input.read(cx).text().to_string(), window, cx),
                InputEvent::Cancel => app.close_settings(window, cx),
                _ => {}
            }));
            inputs.insert(key, input);
        }
        let theme_filter = cx.new(|cx| TextInput::new("テーマを名前で絞り込む", cx));
        subs.push(cx.subscribe_in(&theme_filter, window, |app, _, event, window, cx| match event {
            InputEvent::Cancel => app.close_settings(window, cx),
            _ => cx.notify(),
        }));
        let shortcut_filter = cx.new(|cx| TextInput::new("操作名・区分・キーで絞り込む", cx));
        subs.push(cx.subscribe_in(&shortcut_filter, window, |app, _, event, window, cx| match event {
            InputEvent::Cancel => app.close_settings(window, cx),
            _ => cx.notify(),
        }));
        let command_label = cx.new(|cx| TextInput::new("表示名", cx));
        let command_line = cx.new(|cx| TextInput::new("コマンド（例: npm test）", cx));
        for input in [&command_label, &command_line] {
            subs.push(cx.subscribe_in(input, window, |app, _, event, window, cx| match event {
                InputEvent::Submit { .. } => app.add_command(window, cx),
                InputEvent::Cancel => app.close_settings(window, cx),
                _ => {}
            }));
        }
        self.overview = None;
        self.menu = None;
        self.settings = Some(Settings {
            section: 0,
            inputs,
            theme_filter,
            shortcut_filter,
            command_label,
            command_line,
            themes: list_themes(),
            preview: None,
            capturing: None,
            capture_focus: cx.focus_handle(),
            message: None,
            pending: HashMap::new(),
            _subscriptions: subs,
        });
        if let Some(s) = &self.settings {
            window.focus(&s.capture_focus, cx);
        }
        cx.notify();
    }

    pub(crate) fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.take().is_some() {
            self.refocus(window, cx);
            cx.notify();
        }
    }

    // 設定を書き、すぐ画面に反映する
    fn set_config(&mut self, key: &str, value: Option<Value>, window: &mut Window, cx: &mut Context<Self>) {
        let result = write_config(key, value);
        if let Some(s) = self.settings.as_mut() {
            s.message = result.err();
        }
        self.reload_appearance_now(window, cx);
        if key == "agents" || key == "commands" {
            self.refresh_agents(cx);
        }
    }

    fn schedule_text_save(&mut self, key: &'static str, input: Entity<TextInput>, window: &mut Window, cx: &mut Context<Self>) {
        let task = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(800)).await;
            let _ = this.update_in(cx, |app, window, cx| {
                let text = input.read(cx).text().to_string();
                app.save_text_field(key, text, window, cx);
            });
        });
        if let Some(s) = self.settings.as_mut() {
            s.pending.insert(key, task);
        }
    }

    fn save_text_field(&mut self, key: &'static str, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        let is_color = matches!(key, "accent" | "foreground" | "background" | "appBackground");
        if is_color && !text.is_empty() && Rgb::parse(&text).is_none() {
            if let Some(s) = self.settings.as_mut() {
                s.message = Some(format!("色は #rrggbb の形で書く: {text}"));
            }
            cx.notify();
            return;
        }
        let current = raw_config().get(key).and_then(Value::as_str).map(String::from).unwrap_or_default();
        if current == text {
            return;
        }
        let value = if text.is_empty() && (is_color || key == "editor") { None } else { Some(Value::String(text)) };
        self.set_config(key, value, window, cx);
    }

    // Ghostty の設定を読み、変わる項目と写さない項目を確かめてから取り込む
    fn import_ghostty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (entries, files) = match crate::ghostty::read() {
            Ok(found) => found,
            Err(err) => {
                if let Some(s) = self.settings.as_mut() {
                    s.message = Some(err);
                }
                cx.notify();
                return;
            }
        };
        if files.is_empty() {
            if let Some(s) = self.settings.as_mut() {
                s.message = Some("Ghostty の設定が見つからない".into());
            }
            cx.notify();
            return;
        }
        let (changes, skipped) = crate::ghostty::map(&entries, |n| crate::config::find_theme(n).is_some());
        let raw = raw_config();
        let changed: Vec<(String, Value)> = changes.into_iter().filter(|(k, v)| raw.get(k) != Some(v)).collect();
        let mut body: Vec<String> = changed
            .iter()
            .map(|(k, v)| format!("{k}: {} → {}", raw.get(k).map(|x| x.to_string()).unwrap_or_else(|| "（既定）".into()), v))
            .collect();
        for (k, v, why) in &skipped {
            body.push(format!("写さない: {k} = {v}（{why}）"));
        }
        body.push(format!("読んだファイル: {}", files.iter().map(|f| f.display().to_string()).collect::<Vec<_>>().join("、")));
        let spec = crate::overlay::DialogSpec {
            title: "Ghostty から取り込む".into(),
            body,
            fields: Vec::new(),
            choice: None,
            confirm: "取り込む".into(),
            danger: false,
            blocked: changed.is_empty().then(|| "変わる項目はない".into()),
        };
        self.open_dialog(
            spec,
            std::rc::Rc::new(move |app, _, _, window, cx| {
                for (k, v) in &changed {
                    write_config(k, Some(v.clone()))?;
                }
                app.reload_appearance_now(window, cx);
                Ok(())
            }),
            window,
            cx,
        );
    }

    fn add_command(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = &self.settings else { return };
        let label = s.command_label.read(cx).text().trim().to_string();
        let command = s.command_line.read(cx).text().trim().to_string();
        if label.is_empty() || command.is_empty() {
            return;
        }
        let mut list = cx.global::<Appearance>().config.commands.clone();
        list.push(json!({ "label": label, "command": command }));
        let (a, b) = (s.command_label.clone(), s.command_line.clone());
        a.update(cx, |i, cx| i.set_text("", cx));
        b.update(cx, |i, cx| i.set_text("", cx));
        self.set_config("commands", Some(Value::Array(list)), window, cx);
    }

    pub(crate) fn reload_appearance_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.config_mtime = std::fs::metadata(config_path()).and_then(|m| m.modified()).ok();
        crate::app::load_appearance(self.font_delta, cx);
        crate::bind_keys(cx);
        window.set_background_appearance(crate::app::background_appearance(cx));
        crate::app::apply_blur(cx);
        cx.refresh_windows();
    }

    // テーマの一覧に指を置いたら、見本だけをそのテーマで描く
    fn preview_theme(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_mut() else { return };
        if s.preview != name {
            s.preview = name;
            cx.notify();
        }
    }

    fn on_capture_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.settings.as_ref().and_then(|s| s.capturing) else {
            if event.keystroke.key == "escape" {
                self.close_settings(window, cx);
            }
            return;
        };
        cx.stop_propagation();
        if event.keystroke.key == "escape" {
            if let Some(s) = self.settings.as_mut() {
                s.capturing = None;
            }
            cx.notify();
            return;
        }
        let Some(accelerator) = keystroke_to_accelerator(&event.keystroke) else { return };
        // 同じキーの別の操作があれば、相手の名前を出して保存しない
        let current = current_shortcuts(cx);
        if let Some((other, _)) = current.iter().find(|(o, k)| *o != id && k.as_deref().is_some_and(|k| same_keys(k, &accelerator))) {
            let name = SHORTCUT_LABELS.iter().find(|l| l.0 == *other).map(|l| l.1).unwrap_or(other);
            if let Some(s) = self.settings.as_mut() {
                s.message = Some(format!("{} は「{name}」で使っている", display_accelerator(&accelerator)));
                s.capturing = None;
            }
            cx.notify();
            return;
        }
        let mut map = raw_config().get("keybindings").and_then(Value::as_object).cloned().unwrap_or_default();
        map.insert(id.to_string(), Value::String(accelerator));
        if let Some(s) = self.settings.as_mut() {
            s.capturing = None;
        }
        self.set_config("keybindings", Some(Value::Object(map)), window, cx);
    }

    fn set_shortcut(&mut self, id: &str, value: Option<Value>, window: &mut Window, cx: &mut Context<Self>) {
        let mut map = raw_config().get("keybindings").and_then(Value::as_object).cloned().unwrap_or_default();
        match value {
            Some(v) => {
                map.insert(id.to_string(), v);
            }
            None => {
                map.remove(id);
            }
        }
        let value = (!map.is_empty()).then_some(Value::Object(map));
        self.set_config("keybindings", value, window, cx);
    }

    pub(crate) fn render_settings(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = self.settings.as_ref()?;
        let mut nav = div().id("settings-nav").flex().flex_col().gap(px(2.0)).w(px(220.0)).flex_none().px_2().py_3().border_r_1().border_color(p.border).overflow_y_scroll();
        for (i, label) in SECTIONS.iter().enumerate() {
            let selected = i == s.section;
            nav = nav.child(
                div()
                    .id(("settings-nav", i))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .h(px(36.0))
                    .px_3()
                    .rounded_md()
                    .when(selected, |d| d.bg(p.active).text_color(p.text))
                    .when(!selected, |d| d.text_color(p.muted).hover(|s| s.bg(p.hover)))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        if let Some(s) = app.settings.as_mut() {
                            s.section = i;
                            s.capturing = None;
                        }
                        cx.notify();
                    }))
                    .child(crate::ui::icon(SECTION_ICONS[i], 16.0, if selected { p.text } else { p.muted }))
                    .child(*label),
            );
        }
        let config = cx.global::<Appearance>().config.clone();
        let body = match s.section {
            0 => self.settings_appearance(&config, p, cx),
            1 => self.settings_agents(&config, p, cx),
            2 => self.settings_assist(&config, p, cx),
            3 => self.settings_commands(&config, p, cx),
            4 => self.settings_notifications(&config, p, cx),
            5 => self.settings_shortcuts(p, cx),
            _ => self.settings_advanced(p, cx),
        };
        let capture_focus = s.capture_focus.clone();
        // 信号機の右に「設定」の見出しを置き、帯の空いた所をつかむと窓が動く
        let titlebar = div()
            .id("settings-titlebar")
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap_3()
            .h(px(40.0))
            .pl(px(88.0))
            .pr_2()
            .border_b_1()
            .border_color(p.border)
            .on_mouse_down(MouseButton::Left, |event: &gpui::MouseDownEvent, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(div().font_weight(FontWeight::SEMIBOLD).child("設定"))
            .child(div().flex_1().min_w_0().text_sm().text_color(p.warning).overflow_hidden().text_ellipsis().whitespace_nowrap().children(s.message.clone()))
            .child(
                crate::ui::icon_button("settings-close", "close", "設定を閉じる（Esc）", p.muted, p.hover, p.text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.close_settings(window, cx))),
            );
        let content = div()
            .id("settings-body")
            .flex_1()
            .min_w_0()
            .overflow_y_scroll()
            .pt_3()
            .px(px(32.0))
            .pb(px(48.0))
            .child(
                div()
                    .mb_3()
                    .pb_2()
                    .border_b_1()
                    .border_color(p.border)
                    .text_size(px(20.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SECTIONS[s.section]),
            )
            .child(body);
        Some(
            deferred(
                div()
                    .id("settings")
                    .occlude()
                    .absolute()
                    .inset_0()
                    .size_full()
                    .flex()
                    .flex_col()
                    .bg(p.solid_bg)
                    .text_color(p.text)
                    .track_focus(&capture_focus)
                    .on_key_down(cx.listener(Self::on_capture_key))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(titlebar)
                    .child(div().flex_1().min_h_0().flex().flex_row().child(nav).child(content)),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }

    // 1項目: 名前、操作の部品、説明の順に縦に並べる
    fn field(&self, label: &str, help: Option<&str>, control: AnyElement, disabled: bool, p: &Palette) -> AnyElement {
        self.field_wide(label, help, control, disabled, false, p)
    }

    fn field_wide(&self, label: &str, help: Option<&str>, control: AnyElement, disabled: bool, wide: bool, p: &Palette) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(6.0))
            .when(!wide, |d| d.max_w(px(560.0)))
            .py_3()
            .border_b_1()
            .border_color(p.border.opacity(0.6))
            .when(disabled, |d| d.opacity(0.5))
            .when(!label.is_empty(), |d| d.child(div().font_weight(FontWeight::SEMIBOLD).child(label.to_string())))
            .child(control)
            .children(help.map(|h| div().text_sm().text_color(p.muted).child(h.to_string())))
            .into_any_element()
    }

    // テーマの見本。色はこの見本にだけ当て、アプリの見た目には触らない
    fn theme_preview(&self, name: &str, p: &Palette, cx: &App) -> AnyElement {
        let mut config = cx.global::<Appearance>().config.clone();
        config.theme = if name.is_empty() { None } else { Some(name.to_string()) };
        let (theme, error) = crate::config::resolve_theme(&config);
        if let Some(error) = error {
            return div().text_sm().text_color(p.warning).child(error).into_any_element();
        }
        let chrome = crate::config::chrome_colors(&theme, config.accent.as_deref().and_then(Rgb::parse));
        let c = |rgb: Rgb| hsla(rgb, 1.0);
        let t = &theme.palette;
        let span = |text: &str, color: Option<Rgb>| div().text_color(color.map(c).unwrap_or(c(theme.foreground))).child(text.to_string());
        let line = |parts: Vec<gpui::Div>| div().flex().flex_row().children(parts);
        let terminal = div()
            .flex()
            .flex_col()
            .p_2()
            .bg(c(theme.background))
            .text_color(c(theme.foreground))
            .text_sm()
            .font_family(cx.global::<Appearance>().font.family.clone())
            .child(line(vec![span("user@terp ", Some(t[2])), span("~/project", Some(t[4])), span(" $ ls", None)]))
            .child(line(vec![span("src/  docs/  ", Some(t[4])), span("build.sh*  ", Some(t[2])), span("README.md", None)]))
            .child(line(vec![span("$ git diff", None)]))
            .child(line(vec![span("- const count = 1;", Some(t[1]))]))
            .child(line(vec![span("+ const count = 42;", Some(t[2]))]))
            .child(line(vec![span(" ", None)]))
            .child(line(vec![span("// 色の見本", Some(t[8]))]))
            .child(line(vec![span("const ", Some(t[5])), span("message = ", None), span("\"hello\"", Some(t[2])), span(";", None)]))
            .child(line(vec![
                span("return ", Some(t[5])),
                span("42", Some(t[3])),
                span("; ", None),
                div().bg(c(chrome.selection)).child("選択した文字"),
            ]))
            .child(line(vec![span("$ ", None), div().w(px(8.0)).bg(c(theme.cursor)).child(" ")]));
        let mut swatches = div().flex().flex_row().flex_wrap().gap_1().p_2();
        for (i, color) in t.iter().enumerate() {
            swatches = swatches.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .w(gpui::relative(0.11))
                    .child(div().w_full().h(px(14.0)).bg(c(*color)))
                    .child(div().text_xs().child(i.to_string())),
            );
        }
        let item = |text: &'static str| div().px_2().py_1().child(text);
        div()
            .flex()
            .flex_col()
            .w_full()
            .rounded_md()
            .overflow_hidden()
            .border_1()
            .border_color(c(chrome.border))
            .bg(c(chrome.bg))
            .text_color(c(chrome.text))
            .text_sm()
            .child(div().p_2().font_weight(FontWeight::SEMIBOLD).child(if name.is_empty() { "内蔵の色".to_string() } else { name.to_string() }))
            .child(terminal)
            .child(swatches)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .p_2()
                    .child(
                        div()
                            .flex_1()
                            .border_1()
                            .border_color(c(chrome.border))
                            .child(item("作業").text_color(c(chrome.text_muted)))
                            .child(item("ターミナル").bg(c(chrome.bg_active)))
                            .child(item("ファイル").bg(c(chrome.bg_hover))),
                    )
                    .child(div().px_2().py_1().rounded_md().bg(c(chrome.accent)).text_color(c(chrome.bg)).child("新しいターミナル")),
            )
            .into_any_element()
    }

    fn toggle(&self, key: &'static str, on: bool, disabled: bool, danger: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let color = if danger && on { p.danger } else { p.accent };
        div()
            .id(SharedString::from(format!("toggle-{key}")))
            .w(px(36.0))
            .h(px(20.0))
            .rounded_full()
            .p(px(2.0))
            .flex()
            .when(on, |d| d.justify_end().bg(color))
            .when(!on, |d| d.bg(p.active))
            .when(!disabled, |d| {
                d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.set_config(key, Some(Value::Bool(!on)), window, cx)))
            })
            .child(div().size(px(16.0)).rounded_full().bg(gpui::white()))
            .into_any_element()
    }

    fn choice_control(&self, key: &'static str, current: Value, options: Vec<(Value, String)>, disabled: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().flex_row().flex_wrap().gap_1().max_w(px(420.0));
        for (i, (value, label)) in options.into_iter().enumerate() {
            let selected = value == current;
            row = row.child(
                div()
                    .id(SharedString::from(format!("select-{key}-{i}")))
                    .px_2()
                    .py(px(3.0))
                    .rounded_md()
                    .border_1()
                    .text_sm()
                    .border_color(if selected { p.accent } else { p.border })
                    .when(selected, |d| d.bg(p.accent_fill))
                    .when(!selected && !disabled, |d| d.hover(|s| s.bg(p.hover)))
                    .when(!disabled, |d| {
                        d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                            let v = if value.is_null() { None } else { Some(value.clone()) };
                            app.set_config(key, v, window, cx)
                        }))
                    })
                    .child(label),
            );
        }
        row.into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn stepper(&self, key: &'static str, value: f64, min: f64, max: f64, step: f64, label: String, disabled: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let button = |id: String, text: &'static str, next: f64| {
            let next = (next.clamp(min, max) * 1000.0).round() / 1000.0;
            div()
                .id(SharedString::from(id))
                .size(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(p.border)
                .when(!disabled, |d| d.hover(|s| s.bg(p.hover)))
                .when(!disabled, |d| {
                    d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        let v = if key == "backgroundBlur" && next == 0.0 { Value::Bool(false) } else { json!(next) };
                        app.set_config(key, Some(v), window, cx)
                    }))
                })
                .child(text)
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .child(button(format!("dec-{key}"), "−", value - step))
            .child(div().min_w(px(56.0)).flex().justify_center().text_sm().child(label))
            .child(button(format!("inc-{key}"), "＋", value + step))
            .into_any_element()
    }

    fn text_control(&self, key: &'static str, width: f32, p: &Palette, color: Option<Rgb>, cx: &mut Context<Self>) -> AnyElement {
        let Some(input) = self.settings.as_ref().and_then(|s| s.inputs.get(key)).cloned() else { return div().into_any_element() };
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .when_some(color, |d, c| d.child(div().size(px(18.0)).rounded_sm().border_1().border_color(p.border).bg(hsla(c, 1.0))))
            .child(div().w(px(width)).px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(input))
            .when(color.is_some(), |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("reset-{key}")))
                        .px_2()
                        .py(px(3.0))
                        .rounded_md()
                        .text_xs()
                        .text_color(p.muted)
                        .hover(|s| s.bg(p.hover).text_color(p.text))
                        .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                            if let Some(i) = app.settings.as_ref().and_then(|s| s.inputs.get(key)).cloned() {
                                i.update(cx, |i, cx| i.set_text("", cx));
                            }
                            app.set_config(key, None, window, cx);
                        }))
                        .child("既定に戻す"),
                )
            })
            .into_any_element()
    }

    fn settings_appearance(&self, c: &Config, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let s = self.settings.as_ref().expect("設定を開いている");
        let filter = s.theme_filter.read(cx).text().to_lowercase();
        let current = c.theme.clone().unwrap_or_default();
        let mut names: Vec<(String, String)> = vec![(String::new(), "内蔵の色（Catppuccin Mocha 相当）".into())];
        names.extend(s.themes.iter().map(|n| (n.clone(), n.clone())));
        if !current.is_empty() && !s.themes.contains(&current) {
            names.push((current.clone(), format!("{current}（見つかりません）")));
        }
        let shown = s.preview.clone().unwrap_or_else(|| current.clone());
        let mut list = div()
            .id("theme-list")
            .h(px(320.0))
            .w_full()
            .overflow_y_scroll()
            .rounded_md()
            .border_1()
            .border_color(p.border)
            .on_hover(cx.listener(|app, hovered: &bool, _, cx| {
                if !hovered {
                    app.preview_theme(None, cx);
                }
            }));
        let mut any = false;
        for (i, (value, label)) in names.into_iter().filter(|(_, l)| filter.is_empty() || l.to_lowercase().contains(&filter)).enumerate() {
            any = true;
            let applied = value == current;
            let previewing = value == shown;
            let (v1, v2) = (value.clone(), value.clone());
            list = list.child(
                div()
                    .id(("theme", i))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .min_h(px(32.0))
                    .px_2()
                    .py_1()
                    .border_b_1()
                    .border_color(p.border)
                    .when(previewing, |d| d.bg(p.hover))
                    .hover(|s| s.bg(p.hover))
                    .on_hover(cx.listener(move |app, hovered: &bool, _, cx| {
                        if *hovered {
                            app.preview_theme(Some(v1.clone()), cx);
                        }
                    }))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        let v = if v2.is_empty() { None } else { Some(Value::String(v2.clone())) };
                        app.set_config("theme", v, window, cx);
                    }))
                    .child(div().min_w_0().child(label))
                    .when(applied, |d| d.child(div().flex_none().text_sm().text_color(p.accent).child("使用中"))),
            );
        }
        if !any {
            list = list.child(div().p_2().text_sm().text_color(p.muted).child("該当するテーマなし。絞り込みを変える"));
        }
        let preview = if any { Some(self.theme_preview(&shown, p, cx)) } else { None };
        let theme_control = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap_3()
            .w_full()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .flex_1()
                    .min_w(px(260.0))
                    .child(div().w_full().px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(s.theme_filter.clone()))
                    .child(list),
            )
            .child(div().flex_1().min_w(px(260.0)).children(preview))
            .into_any_element();
        let color = |k: &str| match k {
            "accent" => c.accent.as_deref().and_then(Rgb::parse),
            "foreground" => c.foreground.as_deref().and_then(Rgb::parse),
            "background" => c.background.as_deref().and_then(Rgb::parse),
            _ => c.app_background.as_deref().and_then(Rgb::parse),
        };
        let theme = cx.global::<Appearance>().theme.clone();
        let chrome = cx.global::<Appearance>().chrome.clone();
        let fallback = |k: &str| match k {
            "accent" => chrome.accent,
            "foreground" => theme.foreground,
            "background" => theme.background,
            _ => chrome.bg,
        };
        let blur = c.background_blur.radius() as f64;
        let pets_off = !c.pets;
        div()
            .flex()
            .flex_col()
            .child(self.field(
                "",
                None,
                div()
                    .id("import-ghostty")
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .text_sm()
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.import_ghostty(window, cx)))
                    .child("Ghostty から取り込む")
                    .into_any_element(),
                false,
                p,
            ))
            .child(self.field_wide("テーマ", Some("Ghostty のテーマの書式のファイルを読む。自分で作ったテーマは ~/.config/terp/themes に置く"), theme_control, false, true, p))
            .child(self.field("強調色", Some("新しいターミナルのボタンや未読の印の色。既定に戻すとテーマのカーソルの色になる"), self.text_control("accent", 200.0, p, Some(color("accent").unwrap_or(fallback("accent"))), cx), false, p))
            .child(self.field("文字色", Some("テーマの文字色の代わりに使う。既定に戻すとテーマの色になる"), self.text_control("foreground", 200.0, p, Some(color("foreground").unwrap_or(fallback("foreground"))), cx), false, p))
            .child(self.field("ターミナルの背景色", Some("テーマの背景色の代わりに使う。アプリの背景色を決めていなければ、一覧や枠の色もこの色から作る"), self.text_control("background", 200.0, p, Some(color("background").unwrap_or(fallback("background"))), cx), false, p))
            .child(self.field("アプリの背景色", Some("左の一覧や窓の周りの色。既定に戻すと、ターミナルの背景色を少し暗くした色になる"), self.text_control("appBackground", 200.0, p, Some(color("appBackground").unwrap_or(fallback("appBackground"))), cx), false, p))
            .child(self.field("フォント", Some("CSS の font-family の書き方で、使いたい順に並べる"), self.text_control("fontFamily", 320.0, p, None, cx), false, p))
            .child(self.field("文字の大きさ", None, self.stepper("fontSize", c.font_size as f64, 9.0, 32.0, 1.0, format!("{}px", c.font_size), false, p, cx), false, p))
            .child(self.field("余白（左右）", None, self.stepper("paddingX", c.padding_x as f64, 0.0, 40.0, 1.0, format!("{}px", c.padding_x), false, p, cx), false, p))
            .child(self.field("余白（上下）", None, self.stepper("paddingY", c.padding_y as f64, 0.0, 40.0, 1.0, format!("{}px", c.padding_y), false, p, cx), false, p))
            .child(self.field("最小のコントラスト", None, self.stepper("minimumContrast", c.minimum_contrast as f64, 1.0, 21.0, 0.1, format!("{:.1}", c.minimum_contrast), false, p, cx), false, p))
            .child(self.field(
                "カーソルの形",
                None,
                self.choice_control("cursorStyle", json!(c.cursor_style), vec![(json!("block"), "四角".into()), (json!("bar"), "縦線".into()), (json!("underline"), "下線".into())], false, p, cx),
                false,
                p,
            ))
            .child(self.field("カーソルを点滅", None, self.toggle("cursorBlink", c.cursor_blink, false, false, p, cx), false, p))
            .child(self.field(
                "背景の不透明度",
                None,
                self.stepper("backgroundOpacity", c.background_opacity as f64, 0.2, 1.0, 0.05, format!("{}%", (c.background_opacity * 100.0).round()), false, p, cx),
                false,
                p,
            ))
            .child(self.field(
                "背景のぼかし",
                Some("窓の後ろをぼかす半径。0 でぼかさない"),
                self.stepper("backgroundBlur", blur, 0.0, 60.0, 1.0, if blur == 0.0 { "なし".into() } else { blur.to_string() }, false, p, cx),
                false,
                p,
            ))
            .child(self.field("よく戻るタブに色を付ける", Some("30 分のうちに 3 回以上戻ったタブの背景に、強調色を薄く付ける。5 回以上で少し濃くなる。3 秒以上とどまったときだけ数える"), self.toggle("frequentTabs", c.frequent_tabs, false, false, p, cx), false, p))
            .child(self.field("上の帯にペットを出す", Some("エージェントを動かしているターミナルごとにペットを出す。押すとそのターミナルへ移る"), self.toggle("pets", c.pets, false, false, p, cx), false, p))
            .child(self.field(
                "ペットの種類",
                Some("猫と犬は、考え中は走り、許可待ちは手を振り、終わると跳ねる。車は左から右へ走り抜け、考え中は速く、許可待ちは止まってハザードを点ける"),
                self.choice_control("petKind", json!(c.pet_kind), vec![(json!("cat"), "猫".into()), (json!("dog"), "犬".into()), (json!("car"), "車".into())], pets_off, p, cx),
                pets_off,
                p,
            ))
            .child(self.field(
                "ペットの背景",
                Some("ペットが走る所の後ろに敷く絵"),
                self.choice_control(
                    "petScene",
                    json!(c.pet_scene),
                    vec![(json!("grass"), "草むら".into()), (json!("room"), "家の中".into()), (json!("city"), "ネオン街".into()), (json!("none"), "なし".into())],
                    pets_off,
                    p,
                    cx,
                ),
                pets_off,
                p,
            ))
            .child(self.field("Dock・Finder のアイコンをテーマの色にする", Some("Dock と Finder のアイコンをテーマの色で描く。閉じている間の Dock は、すぐには替わらないことがある"), self.toggle("themedIcon", c.themed_icon, false, false, p, cx), false, p))
            .into_any_element()
    }

    fn settings_agents(&self, c: &Config, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let mut options = vec![(Value::Null, "見つかった最初のもの".to_string())];
        for a in self.found_agents() {
            options.push((json!(a.command), format!("{}（{}）", a.command.rsplit('/').next().unwrap_or(&a.command), a.label)));
        }
        let mut registry = div().flex().flex_col().gap_1().w(px(420.0));
        let (found, missing): (Vec<_>, Vec<_>) = self.agents.iter().partition(|a| a.found());
        registry = registry.child(div().text_xs().text_color(p.muted).child(format!("連携中 ({})", found.len())));
        for a in found {
            let command = a.command.clone();
            let hidden = a.hidden;
            registry = registry.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .child(crate::ui::agent_icon(&a.icon, 14.0, p.text))
                    .child(div().flex_1().text_sm().child(format!("{}（{}）", a.label, a.command)))
                    .child(
                        div()
                            .id(SharedString::from(format!("agent-hide-{}", a.command)))
                            .px_2()
                            .text_xs()
                            .rounded_md()
                            .text_color(p.muted)
                            .hover(|s| s.bg(p.hover).text_color(p.text))
                            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                                let mut list = cx.global::<Appearance>().config.agents.clone();
                                match list.iter_mut().find(|v| v.get("command").and_then(Value::as_str) == Some(command.as_str())) {
                                    Some(Value::Object(m)) => {
                                        m.insert("hidden".into(), Value::Bool(!hidden));
                                    }
                                    _ => list.push(json!({ "command": command, "hidden": !hidden })),
                                }
                                app.set_config("agents", Some(Value::Array(list)), window, cx);
                            }))
                            .child(if hidden { "表示する" } else { "隠す" }),
                    ),
            );
        }
        registry = registry.child(div().mt_2().text_xs().text_color(p.muted).child(format!("未連携 ({})", missing.len())));
        div()
            .flex()
            .flex_col()
            .child(self.field(
                "確認なしで起動する",
                Some("ファイルの読み書きやコマンドの実行の確認を飛ばして起動する（claude は --dangerously-skip-permissions など）。⌥ を押しながら起動すると逆になる"),
                self.toggle("skipApprovals", c.skip_approvals, false, true, p, cx),
                false,
                p,
            ))
            .child(self.field("メインのエージェント", Some("タブの並びの隣のボタンで、プルダウンなしで起動するもの"), self.choice_control("mainAgent", c.main_agent.clone().map(Value::String).unwrap_or(Value::Null), options, false, p, cx), false, p))
            .child(self.field("名前を変えたら会話の名前も変える", Some("ターミナルの名前を付けたとき、claude・codex に /rename を打ち込み、/resume の一覧でも同じ名前にする。考え中や入力の途中は、手が空くまで待ってから送る"), self.toggle("agentRename", c.agent_rename, false, false, p, cx), false, p))
            .child(self.field("AI エージェントの登録一覧", Some("起動のボタンに出すもの。細かい設定（実行ファイルの場所・引数・環境変数）は設定ファイルの agents に書く"), registry.into_any_element(), false, p))
            .into_any_element()
    }

    fn settings_assist(&self, c: &Config, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let off = !c.ai_assist;
        let usage = crate::assist::usage_today();
        div()
            .flex()
            .flex_col()
            .child(self.field("AI の手伝いを使う", Some("切ると下の機能はすべて止まり、claude を呼ばない"), self.toggle("aiAssist", c.ai_assist, false, false, p, cx), false, p))
            .child(self.field(
                "使うモデル",
                Some("haiku は速く、使う量も少ない。sonnet は文の質が上がるが、使う量が増える"),
                self.choice_control("aiModel", json!(c.ai_model), vec![(json!("haiku"), "haiku（おすすめ）".into()), (json!("sonnet"), "sonnet".into())], off, p, cx),
                off,
                p,
            ))
            .child(self.field("ターミナルに名前を付ける", Some("行の右クリックに「AI で名前を付ける」を出す。押したときだけ、画面の末尾（最大 2,000 字）を渡す"), self.toggle("aiNameTerminal", c.ai_name_terminal, off, false, p, cx), off, p))
            .child(self.field("1日の上限", Some("1日に claude を呼ぶ回数の上限。0 で上限なし"), self.stepper("aiDailyLimit", c.ai_daily_limit as f64, 0.0, 1000.0, 1.0, format!("{}回", c.ai_daily_limit), off, p, cx), off, p))
            .child(self.field("今日の使用量", None, div().text_sm().child(format!("{} 回（入力 {} / 出力 {} トークン）", usage.calls, usage.input_tokens, usage.output_tokens)).into_any_element(), false, p))
            .into_any_element()
    }

    fn settings_commands(&self, c: &Config, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let s = self.settings.as_ref().expect("設定を開いている");
        let commands = crate::agents::user_commands(&c.commands);
        let mut list = div().flex().flex_col().gap_1();
        for (i, command) in commands.iter().enumerate() {
            list = list.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .child(div().w(px(140.0)).text_sm().child(command.label.clone()))
                    .child(div().flex_1().text_sm().text_color(p.muted).child(command.command.clone()))
                    .child(
                        crate::ui::icon_button(("cmd-up", i), "chevron-up", "上へ", p.muted, p.hover, p.text).on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                            let mut list = cx.global::<Appearance>().config.commands.clone();
                            if i > 0 && i < list.len() {
                                list.swap(i, i - 1);
                                app.set_config("commands", Some(Value::Array(list)), window, cx);
                            }
                        })),
                    )
                    .child(
                        crate::ui::icon_button(("cmd-remove", i), "trash", "削除", p.muted, p.hover, p.text).on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                            let mut list = cx.global::<Appearance>().config.commands.clone();
                            if i < list.len() {
                                list.remove(i);
                                let v = (!list.is_empty()).then_some(Value::Array(list));
                                app.set_config("commands", v, window, cx);
                            }
                        })),
                    ),
            );
        }
        let input = |e: &Entity<TextInput>, w: f32| div().w(px(w)).px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(e.clone());
        list = list.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .mt_2()
                .child(input(&s.command_label, 140.0))
                .child(div().flex_1().child(input(&s.command_line, 300.0)))
                .child(
                    div()
                        .id("cmd-add")
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .bg(p.accent)
                        .text_color(p.on_accent)
                        .text_sm()
                        .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.add_command(window, cx)))
                        .child("登録"),
                ),
        );
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_xs().text_color(p.muted).child("タブの ＋ のプルダウンに出す。選ぶと、表示中のターミナルと同じ場所で新しいターミナルを開き、コマンドを打つ"))
            .child(list)
            .into_any_element()
    }

    fn settings_notifications(&self, c: &Config, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let off = !c.notifications;
        let action = |id: &'static str, label: &'static str| {
            div().id(id).px_3().py_1().rounded_md().border_1().border_color(p.border).text_sm().hover(|s| s.bg(p.hover)).child(label)
        };
        div()
            .flex()
            .flex_col()
            .child(self.field("通知する", Some("切ると下の5項目は変更できない"), self.toggle("notifications", c.notifications, false, false, p, cx), false, p))
            .child(self.field("応答が終わったとき", None, self.toggle("notifyAgentDone", c.notify_agent_done, off, false, p, cx), off, p))
            .child(self.field("ベルが鳴ったとき", None, self.toggle("notifyBell", c.notify_bell, off, false, p, cx), off, p))
            .child(self.field("表示中のターミナルも知らせる", None, self.toggle("notifyWhenVisible", c.notify_when_visible, off, false, p, cx), off, p))
            .child(self.field("音を鳴らす", Some("音の有無は macOS の「システム設定 → 通知 → terp」でも変えられる"), self.toggle("notifySound", c.notify_sound, off, false, p, cx), off, p))
            .child(self.field("返答の文を出す", Some("ロック画面や画面の共有で、返答の中身が見えることがある"), self.toggle("notifyMessage", c.notify_message, off, false, p, cx), off, p))
            .child(self.field("Dock に数を出す", None, self.toggle("dockBadge", c.dock_badge, false, false, p, cx), false, p))
            .child(self.field("許可待ちに右下のカードで答える", Some("表示していないターミナルが許可を求めたとき、移らずに選べる"), self.toggle("permissionCard", c.permission_card, false, false, p, cx), false, p))
            .child(self.field(
                "試しに通知する",
                Some("macOS の「システム設定 → 通知」で terp の通知を許可していないと出ない"),
                action("test-notify", "試しに通知する")
                    .on_click(cx.listener(|_, _: &ClickEvent, _, cx| {
                        cx.show_system_notification(gpui::SystemNotification { tag: "terp-test".into(), title: "terp".into(), body: "通知の試し".into(), actions: Vec::new() })
                    }))
                    .into_any_element(),
                false,
                p,
            ))
            .into_any_element()
    }

    fn settings_shortcuts(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let s = self.settings.as_ref().expect("設定を開いている");
        let filter = s.shortcut_filter.read(cx).text().to_lowercase();
        let current = current_shortcuts(cx);
        let mut list = div().flex().flex_col();
        let mut last_section = "";
        for (id, label, section) in SHORTCUT_LABELS {
            let key = current.iter().find(|(i, _)| i == id).and_then(|(_, k)| k.clone());
            let shown = key.as_deref().map(display_accelerator).unwrap_or_else(|| "なし".into());
            if !filter.is_empty() && ![label.to_lowercase(), section.to_lowercase(), shown.to_lowercase()].iter().any(|v| v.contains(&filter)) {
                continue;
            }
            if *section != last_section {
                last_section = section;
                list = list.child(div().mt_3().mb_1().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.muted).child(*section));
            }
            let capturing = s.capturing == Some(*id);
            let id_s: &'static str = id;
            let custom = raw_config().get("keybindings").and_then(Value::as_object).is_some_and(|m| m.contains_key(*id));
            let focus = s.capture_focus.clone();
            list = list.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .py_1()
                    .border_b_1()
                    .border_color(p.border)
                    .child(div().flex_1().text_sm().child(*label))
                    .child(
                        div()
                            .id(SharedString::from(format!("sc-{id}")))
                            .min_w(px(120.0))
                            .px_2()
                            .py(px(3.0))
                            .rounded_md()
                            .border_1()
                            .border_color(if capturing { p.accent } else { p.border })
                            .text_sm()
                            .flex()
                            .justify_center()
                            .hover(|s| s.bg(p.hover))
                            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                                if let Some(s) = app.settings.as_mut() {
                                    s.capturing = Some(id_s);
                                    s.message = None;
                                }
                                window.focus(&focus, cx);
                                cx.notify();
                            }))
                            .child(if capturing { "キーを押してください".to_string() } else { shown }),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("sc-off-{id}")))
                            .px_2()
                            .text_xs()
                            .rounded_md()
                            .text_color(p.muted)
                            .hover(|s| s.bg(p.hover).text_color(p.text))
                            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.set_shortcut(id_s, Some(Value::Null), window, cx)))
                            .child("割り当てを外す"),
                    )
                    .when(custom, |d| {
                        d.child(
                            div()
                                .id(SharedString::from(format!("sc-reset-{id}")))
                                .px_2()
                                .text_xs()
                                .rounded_md()
                                .text_color(p.muted)
                                .hover(|s| s.bg(p.hover).text_color(p.text))
                                .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.set_shortcut(id_s, None, window, cx)))
                                .child("既定に戻す"),
                        )
                    }),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(div().w(px(320.0)).px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(s.shortcut_filter.clone()))
                    .child(
                        div()
                            .id("sc-reset-all")
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .border_1()
                            .border_color(p.border)
                            .text_sm()
                            .hover(|s| s.bg(p.hover))
                            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.set_config("keybindings", None, window, cx)))
                            .child("すべて既定に戻す"),
                    ),
            )
            .child(div().text_xs().text_color(p.muted).child("キーの欄を押してから、修飾キー（⌘ ⌥ ⌃）を含む組み合わせを押す。Esc で取り消す"))
            .child(list)
            .into_any_element()
    }

    fn settings_advanced(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .child(self.field(
                "ファイルを開くエディタ",
                Some("端末のパスを開くときのコマンド。{file}・{line}・{col} を置き換える。空なら VS Code（code）があればそれ、無ければ既定のアプリで開く"),
                self.text_control("editor", 320.0, p, None, cx),
                false,
                p,
            ))
            .child(self.field(
                "設定ファイルを開く",
                Some("この画面に無い設定は、設定ファイルに書く"),
                div()
                    .id("open-config-file")
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .text_sm()
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.open_config(&crate::app::OpenConfig, window, cx)))
                    .child("設定ファイルを開く")
                    .into_any_element(),
                false,
                p,
            ))
            .into_any_element()
    }
}

// 今効いている近道（id と Electron の書き方。外したものは None）
pub fn current_shortcuts(cx: &App) -> Vec<(String, Option<String>)> {
    let overrides = cx.global::<Appearance>().config.keybindings.clone();
    crate::shortcut_defaults()
        .into_iter()
        .map(|(id, default)| {
            let key = match overrides.get(id) {
                Some(None) => None,
                Some(Some(custom)) if crate::keys::accelerator_to_gpui(custom).is_some() => Some(custom.clone()),
                _ => Some(default.to_string()),
            };
            (id.to_string(), key)
        })
        .collect()
}

impl Focusable for Settings {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.capture_focus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn キーの見せ方() {
        assert_eq!(display_accelerator("Command+Shift+T"), "⇧⌘T");
        assert_eq!(display_accelerator("Control+Command+]"), "⌃⌘]");
        assert_eq!(display_accelerator("Command+Alt+Left"), "⌥⌘←");
    }

    #[test]
    fn 同じキーを見分ける() {
        assert!(same_keys("Command+Shift+T", "Shift+Command+T"));
        assert!(!same_keys("Command+T", "Command+Shift+T"));
    }
}
