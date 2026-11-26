// 小さいターミナル（クイックターミナル）。端末の枠の右下のボタンか ⌥⌘N で、terp の窓の中に浮かせて出し入れする。
// 1つだけ持ち、隠してもシェルは残すので、次に出したときに続きから使える。左の一覧には出さない。
// 設定で、ボタンで開くものを Terminal や Ghostty に変えられる
use crate::app::{Palette, TerpApp};
use gpui::{AnyElement, ClickEvent, Context, Focusable, MouseButton, Window, div, prelude::*, px};

#[derive(Default)]
pub struct Quick {
    pub id: Option<u64>,
    pub visible: bool,
}

const QUICK_WIDTH: f32 = 560.0;
const QUICK_HEIGHT: f32 = 340.0;

impl TerpApp {
    pub(crate) fn is_quick(&self, id: u64) -> bool {
        self.quick.id == Some(id)
    }

    // ボタンと ⌥⌘N。設定の quickTerminalApp に従い、terp なら出し入れし、ほかはそのアプリでホームを開く
    pub(crate) fn toggle_quick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let app = cx.global::<crate::appearance::Appearance>().config.quick_terminal_app.clone();
        let home = crate::config::home_dir();
        match app.as_str() {
            "terminal" => {
                let _ = std::process::Command::new("/usr/bin/open").args(["-a", "Terminal"]).arg(&home).spawn();
                return;
            }
            "ghostty" => {
                if !std::path::Path::new("/Applications/Ghostty.app").exists() {
                    self.show_toast("Ghostty が見つからない（/Applications/Ghostty.app）".into(), cx);
                    return;
                }
                let _ = std::process::Command::new("/usr/bin/open")
                    .args(["-na", "Ghostty", "--args"])
                    .arg(format!("--working-directory={}", home.display()))
                    .spawn();
                return;
            }
            _ => {}
        }
        if self.quick.visible {
            self.quick.visible = false;
            self.refocus(window, cx);
            cx.notify();
            return;
        }
        if self.quick.id.is_none_or(|id| self.session(id).is_none()) {
            let workspace = self.workspace();
            let Some(id) = self.spawn_session_in(home, workspace.clone(), window, cx) else { return };
            self.quick.id = Some(id);
            if let Some(view) = self.session(id).map(|s| s.view.clone()) {
                view.update(cx, |v, _| {
                    v.quick = true;
                    v.save_meta(&workspace);
                });
            }
        }
        self.quick.visible = true;
        if let Some(view) = self.quick.id.and_then(|id| self.session(id)).map(|s| s.view.clone()) {
            let handle = view.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        cx.notify();
    }

    pub(crate) fn render_quick_button(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let open = self.quick.visible;
        div()
            .id("quick-terminal-button")
            .absolute()
            .right(px(14.0))
            .bottom(px(14.0))
            .flex()
            .items_center()
            .justify_center()
            .size(px(30.0))
            .rounded_full()
            .border_1()
            .border_color(if open { p.accent } else { p.border })
            .bg(p.solid_bg)
            .when(!open, |d| d.opacity(0.7))
            .shadow_md()
            .hover(|s| s.opacity(1.0).bg(p.hover))
            .tooltip(move |_, cx| crate::tooltip::text(if open { "小さいターミナルを隠す（⌥⌘N）" } else { "小さいターミナルを出す（⌥⌘N）" }, cx))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.toggle_quick(window, cx)))
            .child(crate::ui::icon("terminal", 15.0, if open { p.accent } else { p.text }))
            .into_any_element()
    }

    // ボタンの上に浮かせて出す
    pub(crate) fn render_quick_panel(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.quick.visible {
            return None;
        }
        let view = self.quick.id.and_then(|id| self.session(id))?.view.clone();
        let title = view.read(cx).display_name();
        Some(
            div()
                .id("quick-terminal")
                .absolute()
                .right(px(14.0))
                .bottom(px(52.0))
                .w(px(QUICK_WIDTH))
                .h(px(QUICK_HEIGHT))
                .max_w(gpui::relative(0.9))
                .max_h(gpui::relative(0.8))
                .flex()
                .flex_col()
                .rounded_lg()
                .overflow_hidden()
                .border_1()
                .border_color(p.border)
                .bg(p.term_bg)
                .shadow_lg()
                .occlude()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_none()
                        .items_center()
                        .gap_1()
                        .h(px(26.0))
                        .px_2()
                        .bg(p.solid_bg)
                        .border_b_1()
                        .border_color(p.border)
                        .child(crate::ui::icon("terminal", 12.0, p.muted))
                        .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_xs().text_color(p.text).child(title))
                        .child(
                            crate::ui::icon_button("quick-terminal-hide", "minus", "隠す（⌥⌘N）。シェルは残り、次に出したときに続きから使える", p.muted, p.hover, p.text)
                                .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.toggle_quick(window, cx))),
                        ),
                )
                .child(div().flex_1().min_h_0().child(view))
                .into_any_element(),
        )
    }
}
