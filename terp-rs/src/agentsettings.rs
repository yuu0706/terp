// 設定の「AI エージェント」の登録一覧。行を押すと、表示名・場所・引数・環境変数を直せる。
// 書く先は config.json の agents（コマンドごとの上書き）。並びもこの配列の順で決まる
use crate::app::{Palette, TerpApp};
use crate::appearance::Appearance;
use crate::input::{InputEvent, TextInput};
use crate::overlay::DialogSpec;
use gpui::{AnyElement, ClickEvent, Context, Entity, FontWeight, SharedString, Subscription, Task, Window, div, prelude::*, px};
use serde_json::{Map, Value, json};
use std::rc::Rc;
use std::time::Duration;

const FIELDS: [(&str, &str); 4] = [("label", "表示名"), ("path", "コマンドの場所"), ("args", "いつも付ける引数"), ("bypassArgs", "確認を飛ばす引数")];

pub struct AgentEditor {
    open: Option<String>,
    fields: Vec<(&'static str, Entity<TextInput>)>,
    env: Vec<(Entity<TextInput>, Entity<TextInput>)>,
    new_command: Entity<TextInput>,
    new_label: Entity<TextInput>,
    add_error: Option<String>,
    show_unlinked: bool,
    save_task: Option<Task<()>>,
    subs: Vec<Subscription>,
    _new_subs: Vec<Subscription>,
}

impl AgentEditor {
    pub fn new(window: &mut Window, cx: &mut Context<TerpApp>) -> Self {
        let new_command = cx.new(|cx| TextInput::new("コマンドの名前か絶対パス", cx));
        let new_label = cx.new(|cx| TextInput::new("表示名", cx));
        let mut subs = Vec::new();
        for input in [&new_command, &new_label] {
            subs.push(cx.subscribe_in(input, window, |app, _, event, window, cx| match event {
                InputEvent::Submit { .. } => app.add_agent(window, cx),
                InputEvent::Cancel => app.close_settings(window, cx),
                _ => {}
            }));
        }
        AgentEditor { open: None, fields: Vec::new(), env: Vec::new(), new_command, new_label, add_error: None, show_unlinked: false, save_task: None, subs: Vec::new(), _new_subs: subs }
    }
}

fn raw_entry<'a>(list: &'a [Value], command: &str) -> Option<&'a Map<String, Value>> {
    list.iter().filter_map(Value::as_object).find(|m| m.get("command").and_then(Value::as_str) == Some(command))
}

// 1つのエージェントの上書きを変える。項目が command だけになったら、行ごと消さずに残す（並びを保つため）
pub fn patch_entry(list: &mut Vec<Value>, command: &str, changes: &[(&str, Option<Value>)]) {
    let index = match list.iter().position(|v| v.get("command").and_then(Value::as_str) == Some(command)) {
        Some(i) => i,
        None => {
            list.push(json!({ "command": command }));
            list.len() - 1
        }
    };
    if let Some(map) = list[index].as_object_mut() {
        for (key, value) in changes {
            match value {
                Some(v) => {
                    map.insert(key.to_string(), v.clone());
                }
                None => {
                    map.remove(*key);
                }
            }
        }
    }
}

// 今の並び（commands）に合わせて、上書きの配列を並べ直す。上書きの無いものは command だけの行にする
pub fn reorder_entries(list: &[Value], commands: &[String]) -> Vec<Value> {
    commands.iter().map(|c| raw_entry(list, c).map(|m| Value::Object(m.clone())).unwrap_or_else(|| json!({ "command": c }))).collect()
}

// 環境変数の行を読み、名前の誤りと重なりを確かめる。空の名前の行は捨てる
pub fn collect_env(pairs: &[(String, String)]) -> Result<Map<String, Value>, String> {
    let mut map = Map::new();
    for (key, value) in pairs {
        let key = key.trim();
        if key.is_empty() {
            if !value.is_empty() {
                return Err("環境変数の名前を入れる".into());
            }
            continue;
        }
        if !crate::agents::valid_env_name(key) {
            return Err("環境変数の名前は半角英数字と _ を使い、数字で始めない".into());
        }
        if map.insert(key.to_string(), Value::String(value.clone())).is_some() {
            return Err("環境変数の名前が重複している".into());
        }
    }
    Ok(map)
}

impl TerpApp {
    fn agent_editor(&mut self) -> Option<&mut AgentEditor> {
        self.settings.as_mut().map(|s| &mut s.agent_editor)
    }

    fn change_agents(&mut self, change: impl FnOnce(&mut Vec<Value>), window: &mut Window, cx: &mut Context<Self>) {
        let mut list = cx.global::<Appearance>().config.agents.clone();
        change(&mut list);
        let value = (!list.is_empty()).then_some(Value::Array(list));
        self.set_config("agents", value, window, cx);
    }

    fn text_input(&mut self, value: &str, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> (Entity<TextInput>, Subscription) {
        let input = cx.new(|cx| {
            let mut i = TextInput::new(placeholder.to_string(), cx);
            i.set_text(value, cx);
            i
        });
        let sub = cx.subscribe_in(&input, window, |app, _, event, window, cx| match event {
            InputEvent::Changed => app.schedule_agent_save(window, cx),
            InputEvent::Submit { .. } => app.save_agent_editor(window, cx),
            InputEvent::Cancel => app.close_settings(window, cx),
            _ => {}
        });
        (input, sub)
    }

    fn toggle_agent_open(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        let was = self.agent_editor().and_then(|e| e.open.clone());
        if was.is_some() {
            self.save_agent_editor(window, cx);
        }
        if let Some(e) = self.agent_editor() {
            e.open = None;
            e.fields.clear();
            e.env.clear();
            e.subs.clear();
            e.save_task = None;
        }
        if was.as_deref() == Some(command.as_str()) {
            cx.notify();
            return;
        }
        let list = cx.global::<Appearance>().config.agents.clone();
        let raw = raw_entry(&list, &command).cloned().unwrap_or_default();
        let defaults = crate::agents::defaults(&command);
        let mut fields = Vec::new();
        let mut subs = Vec::new();
        for (key, _) in FIELDS {
            let placeholder = match key {
                "label" => defaults.map(|d| d.0.to_string()).unwrap_or_else(|| command.clone()),
                "path" => "空なら PATH から探す".into(),
                "args" => defaults.map(|d| d.2.to_string()).unwrap_or_default(),
                _ => defaults.map(|d| d.1.to_string()).unwrap_or_default(),
            };
            let value = raw.get(key).and_then(Value::as_str).unwrap_or("").to_string();
            let (input, sub) = self.text_input(&value, &placeholder, window, cx);
            fields.push((key, input));
            subs.push(sub);
        }
        let mut env = Vec::new();
        for (k, v) in raw.get("env").and_then(Value::as_object).cloned().unwrap_or_default() {
            let (a, sa) = self.text_input(&k, "EXAMPLE_NAME", window, cx);
            let (b, sb) = self.text_input(v.as_str().unwrap_or(""), "値", window, cx);
            env.push((a, b));
            subs.extend([sa, sb]);
        }
        if let Some(e) = self.agent_editor() {
            e.open = Some(command);
            e.fields = fields;
            e.env = env;
            e.subs = subs;
        }
        cx.notify();
    }

    fn schedule_agent_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let task = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(800)).await;
            let _ = this.update_in(cx, |app, window, cx| app.save_agent_editor(window, cx));
        });
        if let Some(e) = self.agent_editor() {
            e.save_task = Some(task);
        }
    }

    pub(crate) fn save_agent_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(e) = self.settings.as_ref().map(|s| &s.agent_editor) else { return };
        let Some(command) = e.open.clone() else { return };
        let fields: Vec<(&'static str, String)> = e.fields.iter().map(|(k, i)| (*k, i.read(cx).text().trim().to_string())).collect();
        let pairs: Vec<(String, String)> = e.env.iter().map(|(a, b)| (a.read(cx).text().to_string(), b.read(cx).text().to_string())).collect();
        let env = match collect_env(&pairs) {
            Ok(env) => env,
            Err(err) => {
                if let Some(s) = self.settings.as_mut() {
                    s.message = Some(err);
                }
                cx.notify();
                return;
            }
        };
        let list = cx.global::<Appearance>().config.agents.clone();
        let raw = raw_entry(&list, &command).cloned().unwrap_or_default();
        let mut changes: Vec<(&str, Option<Value>)> = fields.iter().map(|(k, v)| (*k, (!v.is_empty()).then(|| Value::String(v.clone())))).collect();
        changes.push(("env", (!env.is_empty()).then_some(Value::Object(env))));
        let unchanged = changes.iter().all(|(k, v)| raw.get(*k) == v.as_ref());
        if let Some(e) = self.agent_editor() {
            e.save_task = None;
        }
        if unchanged {
            return;
        }
        self.change_agents(|list| patch_entry(list, &command, &changes), window, cx);
    }

    fn add_env_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (a, sa) = self.text_input("", "EXAMPLE_NAME", window, cx);
        let (b, sb) = self.text_input("", "値", window, cx);
        if let Some(e) = self.agent_editor() {
            e.env.push((a, b));
            e.subs.extend([sa, sb]);
        }
        cx.notify();
    }

    fn remove_env_row(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(e) = self.agent_editor()
            && index < e.env.len()
        {
            e.env.remove(index);
        }
        self.save_agent_editor(window, cx);
        cx.notify();
    }

    fn move_agent(&mut self, command: &str, up: bool, window: &mut Window, cx: &mut Context<Self>) {
        let mut commands: Vec<String> = self.agents.iter().map(|a| a.command.clone()).collect();
        let Some(at) = commands.iter().position(|c| c == command) else { return };
        let to = if up { at.checked_sub(1) } else { (at + 1 < commands.len()).then_some(at + 1) };
        let Some(to) = to else { return };
        commands.swap(at, to);
        self.change_agents(|list| *list = reorder_entries(list, &commands), window, cx);
    }

    fn remove_agent_entry(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.agent_editor().is_some_and(|e| e.open.as_deref() == Some(command.as_str())) {
            if let Some(e) = self.agent_editor() {
                e.open = None;
                e.fields.clear();
                e.env.clear();
                e.subs.clear();
                e.save_task = None;
            }
        }
        self.change_agents(|list| list.retain(|v| v.get("command").and_then(Value::as_str) != Some(command.as_str())), window, cx);
    }

    fn confirm_agent_removal(&mut self, command: String, label: String, window: &mut Window, cx: &mut Context<Self>) {
        let spec = DialogSpec {
            title: "エージェントを削除".into(),
            body: vec![format!("{label} の登録と起動設定を削除する")],
            fields: Vec::new(),
            choice: None,
            confirm: "削除".into(),
            danger: true,
            blocked: None,
        };
        self.open_dialog(
            spec,
            Rc::new(move |app, _, _, window, cx| {
                app.remove_agent_entry(command.clone(), window, cx);
                Ok(())
            }),
            window,
            cx,
        );
    }

    pub(crate) fn add_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(e) = self.settings.as_ref().map(|s| &s.agent_editor) else { return };
        let command = e.new_command.read(cx).text().trim().to_string();
        let label = e.new_label.read(cx).text().trim().to_string();
        let error = if command.is_empty() || label.is_empty() {
            Some("コマンドと表示名を入れる")
        } else if self.agents.iter().any(|a| a.command == command) {
            Some("同じコマンドが登録されている")
        } else if command.contains(char::is_whitespace) && !command.starts_with('/') {
            Some("コマンドは名前か絶対パスで指定する")
        } else {
            None
        };
        if let Some(err) = error {
            if let Some(e) = self.agent_editor() {
                e.add_error = Some(err.into());
            }
            cx.notify();
            return;
        }
        let (a, b) = (e.new_command.clone(), e.new_label.clone());
        a.update(cx, |i, cx| i.set_text("", cx));
        b.update(cx, |i, cx| i.set_text("", cx));
        if let Some(e) = self.agent_editor() {
            e.add_error = None;
        }
        self.change_agents(|list| list.push(json!({ "command": command, "label": label })), window, cx);
    }

    pub(crate) fn render_agent_registry(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(e) = self.settings.as_ref().map(|s| &s.agent_editor) else { return div().into_any_element() };
        let config = &cx.global::<Appearance>().config;
        let main = config.main_agent.clone().or_else(|| self.found_agents().first().map(|a| a.command.clone()));
        let button = |id: SharedString, label: &str, disabled: bool| {
            div()
                .id(id)
                .px_2()
                .py(px(2.0))
                .rounded_md()
                .border_1()
                .border_color(p.border)
                .text_xs()
                .when(disabled, |d| d.opacity(0.4))
                .when(!disabled, |d| d.hover(|s| s.bg(p.hover)))
                .child(label.to_string())
        };
        let input_box = |input: &Entity<TextInput>| div().flex_1().min_w_0().px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(input.clone());
        let count = self.agents.len();
        let mut linked = div().flex().flex_col().gap_1();
        let mut unlinked = div().flex().flex_col().gap_1();
        let (mut n_linked, mut n_unlinked) = (0, 0);
        for (index, a) in self.agents.iter().enumerate() {
            let open = e.open.as_deref() == Some(a.command.as_str());
            let (c1, c2, c3, c4, c5, c6) = (a.command.clone(), a.command.clone(), a.command.clone(), a.command.clone(), a.command.clone(), a.command.clone());
            let hidden = a.hidden;
            let label = a.label.clone();
            let known = a.known;
            let head = div()
                .id(SharedString::from(format!("agent-row-{}", a.command)))
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .px_2()
                .py_1()
                .rounded_md()
                .hover(|s| s.bg(p.hover))
                .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.toggle_agent_open(c1.clone(), window, cx)))
                .child(crate::ui::icon(if open { "chevron-down" } else { "chevron-right" }, 12.0, p.muted))
                .child(crate::ui::agent_icon(&a.icon, 14.0, p.text))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .gap_2()
                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(a.label.clone()))
                        .child(div().text_xs().text_color(p.muted).overflow_hidden().text_ellipsis().whitespace_nowrap().child(a.command.clone()))
                        .when(main.as_deref() == Some(a.command.as_str()) && a.found() && !hidden, |d| {
                            d.child(div().px_1().rounded_sm().text_xs().text_color(p.on_accent).bg(p.accent).child("メイン"))
                        }),
                )
                .child(
                    button(SharedString::from(format!("agent-visible-{}", a.command)), if hidden { "表示する" } else { "隠す" }, false).on_click(cx.listener(
                        move |app, _: &ClickEvent, window, cx| {
                            cx.stop_propagation();
                            app.change_agents(|list| patch_entry(list, &c2, &[("hidden", (!hidden).then_some(Value::Bool(true)))]), window, cx);
                        },
                    )),
                )
                .child(button(SharedString::from(format!("agent-up-{}", a.command)), "↑", index == 0).when(index > 0, |d| {
                    d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        app.move_agent(&c3, true, window, cx);
                    }))
                }))
                .child(button(SharedString::from(format!("agent-down-{}", a.command)), "↓", index + 1 >= count).when(index + 1 < count, |d| {
                    d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        app.move_agent(&c4, false, window, cx);
                    }))
                }));
            let mut row = div().flex().flex_col().rounded_md().border_1().border_color(if open { p.accent } else { p.border }).child(head);
            if open {
                let mut detail = div().flex().flex_col().gap_2().px_3().pb_3().pt_1();
                for (key, input) in &e.fields {
                    let name = FIELDS.iter().find(|f| f.0 == *key).map(|f| f.1).unwrap_or(key);
                    detail = detail.child(div().flex().flex_row().items_center().gap_2().child(div().w(px(110.0)).flex_none().text_xs().text_color(p.muted).child(name)).child(input_box(input)));
                }
                if let Some(path) = &a.path {
                    detail = detail.child(div().text_xs().text_color(p.muted).child(format!("場所: {}", path.display())));
                }
                let mut env = div().flex().flex_col().gap_1().child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child("環境変数"));
                for (i, (k, v)) in e.env.iter().enumerate() {
                    env = env.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .child(input_box(k))
                            .child(input_box(v))
                            .child(button(SharedString::from(format!("env-remove-{i}")), "消す", false).on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.remove_env_row(i, window, cx)))),
                    );
                }
                env = env.child(div().flex().child(button("env-add".into(), "環境変数を足す", false).on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.add_env_row(window, cx)))));
                detail = detail.child(env);
                let can_main = a.found() && !hidden;
                let mut actions = div().flex().flex_row().gap_2().child(button(SharedString::from(format!("agent-main-{}", a.command)), "メインにする", !can_main).when(can_main, |d| {
                    d.on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.set_config("mainAgent", Some(Value::String(c5.clone())), window, cx)))
                }));
                actions = actions.child(button(SharedString::from(format!("agent-reset-{}", a.command)), if known { "既定に戻す" } else { "削除" }, false).on_click(cx.listener(
                    move |app, _: &ClickEvent, window, cx| {
                        if known {
                            app.remove_agent_entry(c6.clone(), window, cx);
                        } else {
                            app.confirm_agent_removal(c6.clone(), label.clone(), window, cx);
                        }
                    },
                )));
                detail = detail.child(actions);
                row = row.child(detail);
            }
            if a.found() {
                n_linked += 1;
                linked = linked.child(row);
            } else {
                n_unlinked += 1;
                unlinked = unlinked.child(row);
            }
        }
        let show_unlinked = e.show_unlinked;
        let add = div()
            .flex()
            .flex_col()
            .gap_1()
            .mt_2()
            .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child("エージェントを足す"))
            .child(div().flex().flex_row().gap_2().child(input_box(&e.new_command)).child(input_box(&e.new_label)).child(button("agent-add".into(), "追加", false).on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.add_agent(window, cx)))))
            .children(e.add_error.clone().map(|err| div().text_xs().text_color(p.danger).child(err)));
        div()
            .flex()
            .flex_col()
            .gap_1()
            .w_full()
            .max_w(px(560.0))
            .child(div().text_xs().text_color(p.muted).child(format!("連携中 {n_linked}")))
            .child(linked)
            .child(
                div()
                    .id("agents-unlinked")
                    .mt_2()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .text_xs()
                    .text_color(p.muted)
                    .hover(|s| s.text_color(p.text))
                    .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                        if let Some(e) = app.agent_editor() {
                            e.show_unlinked = !e.show_unlinked;
                        }
                        cx.notify();
                    }))
                    .child(crate::ui::icon(if show_unlinked { "chevron-down" } else { "chevron-right" }, 12.0, p.muted))
                    .child(format!("未連携 {n_unlinked}")),
            )
            .when(show_unlinked, |d| d.child(unlinked))
            .child(add)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 上書きの項目を足し_空にした項目は消す() {
        let mut list = vec![json!({ "command": "claude", "args": "--x", "label": "C" })];
        patch_entry(&mut list, "claude", &[("args", None), ("path", Some(json!("/usr/bin/claude")))]);
        patch_entry(&mut list, "codex", &[("hidden", Some(json!(true)))]);
        assert_eq!(list, vec![json!({ "command": "claude", "label": "C", "path": "/usr/bin/claude" }), json!({ "command": "codex", "hidden": true })]);
    }

    #[test]
    fn 並べ替えは今の並びに合わせ_上書きを保つ() {
        let list = vec![json!({ "command": "codex", "label": "X" })];
        let out = reorder_entries(&list, &["claude".into(), "codex".into()]);
        assert_eq!(out, vec![json!({ "command": "claude" }), json!({ "command": "codex", "label": "X" })]);
    }

    #[test]
    fn 環境変数は名前の誤りと重なりを断り_空の行は捨てる() {
        let ok = collect_env(&[("A_1".into(), "x".into()), ("".into(), "".into())]).unwrap();
        assert_eq!(Value::Object(ok), json!({ "A_1": "x" }));
        assert!(collect_env(&[("1A".into(), "x".into())]).is_err());
        assert!(collect_env(&[("A".into(), "x".into()), ("A".into(), "y".into())]).is_err());
        assert!(collect_env(&[("".into(), "x".into())]).is_err());
    }
}
