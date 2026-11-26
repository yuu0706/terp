// 小さいターミナル（クイックターミナル）。端末の枠の右下のボタンか ⌥⌘N で、小さな窓を出し入れする。
// 初めは terp の窓の中の右下に出し、上の帯をつかめば窓の外へも動かせる。
// 1つだけ持ち、隠してもシェルは残すので、次に出したときに続きから使える。左の一覧には出さない。
// 設定で、ボタンで開くものを Terminal や Ghostty に変えられる
use crate::app::{Palette, TerpApp};
use crate::terminal_view::TerminalView;
use gpui::{
    AnyElement, Bounds, ClickEvent, Context, DisplayId, Entity, Focusable, MouseButton, Pixels, Render, TitlebarOptions, WeakEntity, Window, WindowBounds, WindowHandle,
    WindowKind, WindowOptions, div, point, prelude::*, px, size,
};

#[derive(Default)]
pub struct Quick {
    pub id: Option<u64>,
    // 出しているときの窓。隠すと閉じ、端末は残す
    pub window: Option<WindowHandle<QuickWindow>>,
    // 最後に置いた位置と大きさと、その画面。次に出すときもそこに出す（位置は画面の左上からの距離）
    pub bounds: Option<(Bounds<Pixels>, Option<DisplayId>)>,
}

impl Quick {
    pub fn visible(&self) -> bool {
        self.window.is_some()
    }
}

const QUICK_WIDTH: f32 = 560.0;
const QUICK_HEIGHT: f32 = 340.0;

// 小さいターミナルの窓。上の帯をつかむと、terp の窓の中でも外でも動かせる
pub struct QuickWindow {
    app: WeakEntity<TerpApp>,
    view: Entity<TerminalView>,
}

impl Render for QuickWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = crate::app::palette(cx);
        let font = cx.global::<crate::appearance::Appearance>().font.clone();
        let app = self.app.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(p.term_bg)
            .text_color(p.text)
            .font_family(font.family)
            .child(
                div()
                    .id("quick-bar")
                    .flex()
                    .flex_row()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .h(px(26.0))
                    .pl(px(80.0))
                    .pr_2()
                    .bg(p.solid_bg)
                    .border_b_1()
                    .border_color(p.border)
                    .on_mouse_down(MouseButton::Left, |_: &gpui::MouseDownEvent, window, _| window.start_window_move())
                    .child(div().flex_1().min_w_0().text_xs().child("terp"))
                    .child(
                        crate::ui::icon_button("quick-terminal-hide", "minus", "隠す（⌥⌘N）。シェルは残り、次に出したときに続きから使える", p.muted, p.hover, p.text)
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(move |_: &ClickEvent, _, cx| {
                                if let Some(app) = app.upgrade() {
                                    app.update(cx, |app, cx| app.hide_quick(cx));
                                }
                            }),
                    ),
            )
            .child(div().flex_1().min_h_0().child(self.view.clone()))
    }
}

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
        if self.quick.visible() {
            self.hide_quick(cx);
            self.refocus(window, cx);
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
        let Some(view) = self.quick.id.and_then(|id| self.session(id)).map(|s| s.view.clone()) else { return };
        // 初めは terp の窓の中の右下（ボタンの上）に、terp の窓と同じ画面で出す
        let (bounds, display_id) = self.quick.bounds.unwrap_or_else(|| {
            let main = window.bounds();
            let size = size(px(QUICK_WIDTH).min(main.size.width * 0.9), px(QUICK_HEIGHT).min(main.size.height * 0.8));
            (Bounds::new(point(main.right() - size.width - px(22.0), main.bottom() - size.height - px(60.0)), size), window.display(cx).map(|d| d.id()))
        });
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("terp".into()), appears_transparent: true, traffic_light_position: Some(point(px(8.0), px(7.0))) }),
            kind: WindowKind::Floating,
            display_id,
            window_background: crate::app::background_appearance(cx),
            window_min_size: Some(size(px(240.0), px(140.0))),
            ..Default::default()
        };
        let app = cx.entity().downgrade();
        let focus = view.read(cx).focus_handle(cx);
        let opened = cx.open_window(options, |w, cx| {
            w.on_next_frame(move |w, cx| w.focus(&focus, cx));
            // 閉じるボタンは、隠すのと同じにする
            let back = app.clone();
            w.on_window_should_close(cx, move |w, cx| {
                let bounds = (w.bounds(), w.display(cx).map(|d| d.id()));
                if let Some(app) = back.upgrade() {
                    app.update(cx, |app, cx| {
                        app.quick.bounds = Some(bounds);
                        app.quick.window = None;
                        cx.notify();
                    });
                }
                true
            });
            cx.new(|cx| {
                let back = app.clone();
                cx.observe_window_bounds(w, move |_: &mut QuickWindow, w, cx| {
                    let bounds = (w.bounds(), w.display(cx).map(|d| d.id()));
                    if let Some(app) = back.upgrade() {
                        app.update(cx, |app, _| app.quick.bounds = Some(bounds));
                    }
                })
                .detach();
                QuickWindow { app, view }
            })
        });
        match opened {
            Ok(handle) => self.quick.window = Some(handle),
            Err(err) => self.show_toast(format!("小さいターミナルを開けない: {err}"), cx),
        }
        cx.notify();
    }

    pub(crate) fn hide_quick(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = self.quick.window.take() {
            let _ = handle
                .update(cx, |_, w, cx| {
                    let bounds = (w.bounds(), w.display(cx).map(|d| d.id()));
                    w.remove_window();
                    bounds
                })
                .map(|b| self.quick.bounds = Some(b));
        }
        cx.notify();
    }

    // 端末が終わったら、窓も閉じて忘れる
    pub(crate) fn drop_quick(&mut self, cx: &mut Context<Self>) {
        self.hide_quick(cx);
        self.quick.id = None;
    }

    pub(crate) fn render_quick_button(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let open = self.quick.visible();
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
}
