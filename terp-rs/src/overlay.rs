// 画面の上に重ねるもの: 押した所に出すメニューと、真ん中に出す確認・入力の窓。
use crate::app::{Palette, TerpApp};
use crate::input::{InputEvent, TextInput};
use gpui::{
    AnyElement, ClickEvent, Context, Entity, Focusable, FontWeight, MouseButton, Pixels, Point, Subscription, Window,
    anchored, deferred, div, prelude::*, px,
};
use std::rc::Rc;

pub type AppAction = Rc<dyn Fn(&mut TerpApp, &mut Window, &mut Context<TerpApp>)>;
// 入力欄の値を受け取る。Err の文は窓に出して閉じない
pub type ConfirmAction = Rc<dyn Fn(&mut TerpApp, Vec<String>, usize, &mut Window, &mut Context<TerpApp>) -> Result<(), String>>;

pub fn action(f: impl Fn(&mut TerpApp, &mut Window, &mut Context<TerpApp>) + 'static) -> AppAction {
    Rc::new(f)
}

#[derive(Clone)]
pub struct MenuItem {
    pub label: String,
    pub hint: Option<String>,
    // 押せない理由。あれば薄く出して押せなくする
    pub disabled: Option<String>,
    pub checked: bool,
    pub separator: bool,
    pub action: Option<AppAction>,
}

impl MenuItem {
    pub fn new(label: impl Into<String>, action: AppAction) -> MenuItem {
        MenuItem { label: label.into(), hint: None, disabled: None, checked: false, separator: false, action: Some(action) }
    }

    pub fn separator() -> MenuItem {
        MenuItem { label: String::new(), hint: None, disabled: None, checked: false, separator: true, action: None }
    }

    pub fn disabled(label: impl Into<String>, reason: impl Into<String>) -> MenuItem {
        MenuItem { label: label.into(), hint: None, disabled: Some(reason.into()), checked: false, separator: false, action: None }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> MenuItem {
        self.hint = Some(hint.into());
        self
    }

    pub fn checked(mut self, checked: bool) -> MenuItem {
        self.checked = checked;
        self
    }
}

pub struct Menu {
    pub position: Point<Pixels>,
    pub items: Vec<MenuItem>,
}

pub struct Choice {
    pub label: String,
    pub options: Vec<String>,
    pub selected: usize,
}

pub struct Dialog {
    pub title: String,
    pub body: Vec<String>,
    pub fields: Vec<(String, Entity<TextInput>)>,
    pub choice: Option<Choice>,
    pub confirm: String,
    pub danger: bool,
    // 押せない理由。あれば確定のボタンを押せなくする
    pub blocked: Option<String>,
    pub busy: Option<String>,
    pub error: Option<String>,
    pub on_confirm: ConfirmAction,
    pub _subscriptions: Vec<Subscription>,
}

pub struct DialogSpec {
    pub title: String,
    pub body: Vec<String>,
    // （ラベル, 初めの値, 案内）
    pub fields: Vec<(String, String, String)>,
    pub choice: Option<Choice>,
    pub confirm: String,
    pub danger: bool,
    pub blocked: Option<String>,
}

impl TerpApp {
    pub fn open_menu(&mut self, position: Point<Pixels>, items: Vec<MenuItem>, cx: &mut Context<Self>) {
        self.menu = Some(Menu { position, items });
        cx.notify();
    }

    pub fn close_menu(&mut self, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            cx.notify();
        }
    }

    pub fn open_dialog(&mut self, spec: DialogSpec, on_confirm: ConfirmAction, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let mut fields = Vec::new();
        let mut subscriptions = Vec::new();
        for (label, value, placeholder) in spec.fields {
            let input = cx.new(|cx| {
                let mut input = TextInput::new(placeholder, cx);
                input.set_text(&value, cx);
                input.select_all_text(cx);
                input
            });
            subscriptions.push(cx.subscribe_in(&input, window, |app, _, event, window, cx| match event {
                InputEvent::Submit { .. } => app.confirm_dialog(window, cx),
                InputEvent::Cancel => app.cancel_dialog(window, cx),
                InputEvent::Tab { back } => app.focus_dialog_field(*back, window, cx),
                InputEvent::Changed => {
                    if let Some(d) = app.dialog.as_mut() {
                        d.error = None;
                    }
                    cx.notify();
                }
                _ => {}
            }));
            fields.push((label, input));
        }
        if let Some((_, first)) = fields.first() {
            window.focus(&first.focus_handle(cx), cx);
        } else {
            window.focus(&self.focus, cx);
        }
        self.dialog = Some(Dialog {
            title: spec.title,
            body: spec.body,
            fields,
            choice: spec.choice,
            confirm: spec.confirm,
            danger: spec.danger,
            blocked: spec.blocked,
            busy: None,
            error: None,
            on_confirm,
            _subscriptions: subscriptions,
        });
        cx.notify();
    }

    fn focus_dialog_field(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = &self.dialog else { return };
        let n = d.fields.len();
        if n < 2 {
            return;
        }
        let at = d.fields.iter().position(|(_, i)| i.read(cx).focus_handle(cx).is_focused(window)).unwrap_or(0);
        let next = if back { (at + n - 1) % n } else { (at + 1) % n };
        let handle = d.fields[next].1.focus_handle(cx);
        window.focus(&handle, cx);
    }

    pub fn confirm_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = &self.dialog else { return };
        if d.blocked.is_some() || d.busy.is_some() {
            return;
        }
        let values: Vec<String> = d.fields.iter().map(|(_, i)| i.read(cx).text().to_string()).collect();
        let choice = d.choice.as_ref().map(|c| c.selected).unwrap_or(0);
        let action = d.on_confirm.clone();
        match action(self, values, choice, window, cx) {
            Ok(()) => {
                // 確定の処理が次の窓を開いたときは、それを残す
                if self.dialog.as_ref().is_some_and(|d| Rc::ptr_eq(&d.on_confirm, &action)) && self.dialog.as_ref().is_some_and(|d| d.busy.is_none()) {
                    self.dialog = None;
                    self.refocus(window, cx);
                }
            }
            Err(message) => {
                if let Some(d) = self.dialog.as_mut() {
                    d.error = Some(message);
                }
            }
        }
        cx.notify();
    }

    pub fn cancel_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dialog.take().is_some() {
            self.refocus(window, cx);
            cx.notify();
        }
    }

    pub fn render_menu(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref()?;
        let mut list = div()
            .id("menu")
            .occlude()
            .min_w(px(200.0))
            .max_w(px(360.0))
            .py_1()
            .rounded_lg()
            .border_1()
            .border_color(p.border)
            .bg(p.solid_bg)
            .shadow_lg()
            .text_sm()
            .text_color(p.text)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        for (i, item) in menu.items.iter().enumerate() {
            if item.separator {
                list = list.child(div().my_1().h(px(1.0)).bg(p.border));
                continue;
            }
            let enabled = item.disabled.is_none() && item.action.is_some();
            let action = item.action.clone();
            list = list.child(
                div()
                    .id(("menu-item", i))
                    .flex()
                    .flex_col()
                    .mx_1()
                    .px_2()
                    .py(px(5.0))
                    .rounded_md()
                    .when(enabled, |d| d.hover(|s| s.bg(p.accent_fill)))
                    .when(!enabled, |d| d.text_color(p.muted))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        if let Some(action) = &action {
                            app.menu = None;
                            action(app, window, cx);
                            cx.notify();
                        }
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .child(div().w(px(12.0)).flex_none().child(if item.checked { "✓" } else { "" }))
                            .child(div().flex_1().child(item.label.clone()))
                            .children(item.hint.clone().map(|h| div().text_xs().text_color(p.muted).child(h))),
                    )
                    .children(item.disabled.clone().filter(|r| !r.is_empty()).map(|r| div().pl(px(20.0)).text_xs().text_color(p.muted).child(r))),
            );
        }
        Some(
            deferred(
                div()
                    .id("menu-backdrop")
                    .absolute()
                    .inset_0()
                    .size_full()
                    .on_mouse_down(MouseButton::Left, cx.listener(|app, _, _, cx| app.close_menu(cx)))
                    .on_mouse_down(MouseButton::Right, cx.listener(|app, _, _, cx| app.close_menu(cx)))
                    .child(anchored().position(menu.position).snap_to_window_with_margin(px(8.0)).child(list)),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    pub fn render_dialog(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let d = self.dialog.as_ref()?;
        let mut card = div()
            .id("dialog")
            .occlude()
            .w(px(480.0))
            .max_h(gpui::relative(0.85))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded_xl()
            .border_1()
            .border_color(p.border)
            .bg(p.solid_bg)
            .shadow_lg()
            .text_sm()
            .text_color(p.text)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child(d.title.clone()));
        for line in &d.body {
            card = card.child(div().text_color(p.muted).child(line.clone()));
        }
        for (label, input) in &d.fields {
            card = card.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_xs().text_color(p.muted).child(label.clone()))
                    .child(div().px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).child(input.clone())),
            );
        }
        if let Some(choice) = &d.choice {
            let mut options = div().flex().flex_col().gap(px(2.0));
            for (i, option) in choice.options.iter().enumerate() {
                let selected = i == choice.selected;
                options = options.child(
                    div()
                        .id(("dialog-choice", i))
                        .flex()
                        .flex_row()
                        .gap_2()
                        .px_2()
                        .py_1()
                        .rounded_md()
                        .when(selected, |d| d.bg(p.accent_fill))
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                            if let Some(c) = app.dialog.as_mut().and_then(|d| d.choice.as_mut()) {
                                c.selected = i;
                            }
                            cx.notify();
                        }))
                        .child(div().w(px(12.0)).child(if selected { "●" } else { "○" }))
                        .child(option.clone()),
                );
            }
            card = card.child(
                div().flex().flex_col().gap_1().child(div().text_xs().text_color(p.muted).child(choice.label.clone())).child(options),
            );
        }
        if let Some(error) = d.error.clone().or_else(|| d.blocked.clone()) {
            card = card.child(div().text_color(p.warning).child(error));
        }
        let disabled = d.blocked.is_some() || d.busy.is_some();
        let confirm_label = d.busy.clone().unwrap_or_else(|| d.confirm.clone());
        let confirm_bg = if d.danger { p.danger } else { p.accent };
        card = card.child(
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap_2()
                .child(
                    div()
                        .id("dialog-cancel")
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(p.border)
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.cancel_dialog(window, cx)))
                        .child("キャンセル"),
                )
                .child(
                    div()
                        .id("dialog-confirm")
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .bg(confirm_bg)
                        .text_color(p.on_accent)
                        .when(disabled, |d| d.opacity(0.5))
                        .when(!disabled, |d| d.hover(|s| s.opacity(0.9)))
                        .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.confirm_dialog(window, cx)))
                        .child(confirm_label),
                ),
        );
        Some(
            deferred(
                div()
                    .id("dialog-backdrop")
                    .absolute()
                    .inset_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::black().opacity(0.35))
                    .on_mouse_down(MouseButton::Left, cx.listener(|app, _, window, cx| app.cancel_dialog(window, cx)))
                    .child(card),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }
}

