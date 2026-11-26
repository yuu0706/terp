// 小さい別の窓のターミナル。枠のタブとは別に、ほかのアプリの上に浮かせて使う。
// 端末そのものは本体の一覧に残し、窓を閉じたら枠のタブへ戻す（シェルは終わらせない）
use crate::app::TerpApp;
use crate::appearance::{Appearance, hsla};
use crate::terminal_view::TerminalView;
use gpui::{
    AnyWindowHandle, App, Bounds, ClickEvent, Context, Entity, Focusable, MouseButton, Pixels, Render, Size, TitlebarOptions, WeakEntity, Window, WindowBounds,
    WindowHandle, WindowOptions, div, point, prelude::*, px, size,
};
use serde::{Deserialize, Serialize};

pub const FLOATING_SIZE: Size<Pixels> = Size { width: px(560.0), height: px(340.0) };

// 開き直すときに戻す窓の位置と大きさ。key は常駐のプロセスでのシェルの番号
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedFloating {
    pub key: u64,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub pinned: bool,
}

pub struct Floating {
    pub id: u64,
    pub window: WindowHandle<FloatingTerminal>,
}

pub struct FloatingTerminal {
    app: WeakEntity<TerpApp>,
    view: Entity<TerminalView>,
    pub pinned: bool,
    // 今の窓の位置と大きさ（開き直すときに戻す）
    bounds: Bounds<Pixels>,
}

// 窓をほかのアプリの上に浮かせるか。全画面の上と、どの操作スペースにも出す
fn set_pinned(window: &Window, pinned: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else { return };
    let view = appkit.ns_view.as_ptr() as *mut objc2::runtime::AnyObject;
    // NSFloatingWindowLevel = 3、NSNormalWindowLevel = 0。CanJoinAllSpaces(1) | FullScreenAuxiliary(256)
    let (level, behavior): (isize, usize) = if pinned { (3, 1 | 256) } else { (0, 0) };
    unsafe {
        let ns_window: *mut objc2::runtime::AnyObject = objc2::msg_send![view, window];
        if ns_window.is_null() {
            return;
        }
        let _: () = objc2::msg_send![ns_window, setLevel: level];
        let _: () = objc2::msg_send![ns_window, setCollectionBehavior: behavior];
    }
}

impl FloatingTerminal {
    fn toggle_pin(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pinned = !self.pinned;
        set_pinned(window, self.pinned);
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| app.persist(cx));
        }
        cx.notify();
    }
}

impl Render for FloatingTerminal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let a = cx.global::<Appearance>();
        let chrome = a.chrome.clone();
        let (text, muted, border, hover, accent, bg, term_bg) = (
            hsla(chrome.text, 1.0),
            hsla(chrome.text_muted, 1.0),
            hsla(chrome.border, 1.0),
            hsla(chrome.bg_hover, 1.0),
            hsla(chrome.accent, 1.0),
            hsla(chrome.bg, 1.0),
            hsla(chrome.term_bg, 1.0),
        );
        let title = self.view.read(cx).display_name();
        window.set_window_title(&format!("{title} — terp"));
        let pinned = self.pinned;
        let button = |id: &'static str, label: &'static str, tip: &'static str| {
            div()
                .id(id)
                .px_2()
                .py(px(1.0))
                .rounded_md()
                .text_xs()
                .text_color(muted)
                .hover(move |s| s.bg(hover).text_color(text))
                .tooltip(move |_, cx| crate::tooltip::text(tip, cx))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(label)
        };
        let bar = div()
            .id("floating-bar")
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap_1()
            .h(px(28.0))
            .pl(px(76.0))
            .pr_2()
            .bg(bg)
            .border_b_1()
            .border_color(border)
            .on_mouse_down(MouseButton::Left, |event: &gpui::MouseDownEvent, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_xs().text_color(text).child(title))
            .child(
                button("floating-pin", if pinned { "最前面を外す" } else { "最前面に固定" }, "ほかのアプリの上に浮かせるか")
                    .when(pinned, move |d| d.text_color(accent))
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_pin(window, cx))),
            )
            .child(button("floating-back", "タブに戻す", "この窓を閉じ、ターミナルを枠のタブへ戻す").on_click(cx.listener(|_, _: &ClickEvent, window, _| window.remove_window())));
        div().size_full().flex().flex_col().bg(term_bg).text_color(text).font_family(a.font.family.clone()).child(bar).child(div().flex_1().min_h_0().child(self.view.clone()))
    }
}

impl TerpApp {
    pub(crate) fn floating_of(&self, id: u64) -> Option<&Floating> {
        self.floating.iter().find(|f| f.id == id)
    }

    // 新しいシェルを小さい窓で開く。場所は表示中のタブの作業と同じ
    pub(crate) fn open_new_floating(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let cwd = self.new_terminal_place(cx);
        let Some(id) = self.spawn_session(cwd, window, cx) else { return };
        self.open_floating(id, None, true, window, cx);
    }

    // 端末を小さい窓へ出す。枠のタブからは外す
    pub(crate) fn open_floating(&mut self, id: u64, saved: Option<&SavedFloating>, pinned: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(f) = self.floating_of(id) {
            let handle = f.window;
            let _ = handle.update(cx, |_, w, _| w.activate_window());
            return;
        }
        let Some(view) = self.session(id).map(|s| s.view.clone()) else { return };
        let Some(workspace) = self.session(id).map(|s| s.workspace.clone()) else { return };
        let was_active = self.active_id() == Some(id);
        let recent = self.recent.clone();
        if let Some(layout) = self.layouts.get_mut(&workspace) {
            layout.remove_tab(id, &recent);
        }
        if was_active {
            match self.active_id() {
                Some(next) => self.select(next, window, cx),
                None => window.focus(&self.focus, cx),
            }
        }
        let bounds = match saved {
            Some(s) => Bounds::new(point(px(s.x), px(s.y)), size(px(s.width), px(s.height))),
            None => {
                // 主の窓のある画面の右下に置く
                let screen = window.display(cx).map(|d| d.visible_bounds()).unwrap_or_else(|| Bounds::new(point(px(0.0), px(0.0)), size(px(1440.0), px(900.0))));
                let offset = px(24.0) + px(28.0) * self.floating.len() as f32;
                Bounds::new(point(screen.right() - FLOATING_SIZE.width - offset, screen.bottom() - FLOATING_SIZE.height - offset), FLOATING_SIZE)
            }
        };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("terp".into()), appears_transparent: true, traffic_light_position: Some(point(px(10.0), px(8.0))) }),
            window_background: crate::app::background_appearance(cx),
            window_min_size: Some(size(px(280.0), px(160.0))),
            ..Default::default()
        };
        let app = cx.entity().downgrade();
        let focus = view.read(cx).focus_handle(cx);
        let opened = cx.open_window(options, |w, cx| {
            let handle = w.window_handle();
            w.on_next_frame(move |w, cx| {
                set_pinned(w, pinned);
                w.focus(&focus, cx);
            });
            // 窓を閉じたら、端末を枠のタブへ戻す
            let back = app.clone();
            w.on_window_should_close(cx, move |_, cx| {
                if let Some(app) = back.upgrade() {
                    app.update(cx, |app, cx| app.floating_closed(id, handle, cx));
                }
                true
            });
            cx.new(|cx| {
                // 窓を動かしたり大きさを変えたりしたら、控えに書く
                let watch = cx.observe_window_bounds(w, |this: &mut FloatingTerminal, w, cx| {
                    this.bounds = w.bounds();
                    if let Some(app) = this.app.upgrade() {
                        app.update(cx, |app, cx| app.persist(cx));
                    }
                });
                watch.detach();
                FloatingTerminal { app, view, pinned, bounds }
            })
        });
        match opened {
            Ok(handle) => self.floating.push(Floating { id, window: handle }),
            Err(err) => {
                self.notice = Some(format!("小さい窓を開けない: {err}"));
                self.layout_mut().show_tab(id);
            }
        }
        self.persist(cx);
        cx.notify();
    }

    fn floating_closed(&mut self, id: u64, handle: AnyWindowHandle, cx: &mut Context<Self>) {
        if !self.floating.iter().any(|f| f.id == id && f.window.window_id() == handle.window_id()) {
            return;
        }
        self.floating.retain(|f| f.id != id);
        if let Some(workspace) = self.session(id).map(|s| s.workspace.clone()) {
            let layout = self.layouts.entry(workspace).or_default();
            if !layout.all_tabs().contains(&id) {
                layout.show_tab(id);
            }
        }
        self.persist(cx);
        cx.notify();
    }

    // 端末が終わった・閉じたときに、窓も閉じる（タブには戻さない）
    pub(crate) fn drop_floating(&mut self, id: u64, cx: &mut App) {
        let Some(index) = self.floating.iter().position(|f| f.id == id) else { return };
        let f = self.floating.remove(index);
        let _ = f.window.update(cx, |_, w, _| w.remove_window());
    }

    pub(crate) fn saved_floating(&self, to_host: &std::collections::HashMap<u64, u64>, cx: &App) -> Vec<SavedFloating> {
        let mut out = Vec::new();
        for f in &self.floating {
            let Some(key) = to_host.get(&f.id).copied() else { continue };
            if let Ok(this) = f.window.read(cx) {
                let b = this.bounds;
                out.push(SavedFloating { key, x: f32::from(b.origin.x), y: f32::from(b.origin.y), width: f32::from(b.size.width), height: f32::from(b.size.height), pinned: this.pinned });
            }
        }
        out
    }

    pub(crate) fn render_floating_button(&self, p: &crate::app::Palette, cx: &mut Context<Self>) -> gpui::AnyElement {
        div()
            .id("open-floating")
            .absolute()
            .right(px(14.0))
            .bottom(px(14.0))
            .flex()
            .items_center()
            .justify_center()
            .size(px(30.0))
            .rounded_full()
            .border_1()
            .border_color(p.border)
            .bg(p.solid_bg)
            .opacity(0.7)
            .shadow_md()
            .hover(|s| s.opacity(1.0).bg(p.hover))
            .tooltip(|_, cx| crate::tooltip::text("小さい窓のターミナルを開く（⌥⌘N）", cx))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.open_new_floating(window, cx)))
            .child(crate::ui::icon("terminal", 15.0, p.text))
            .into_any_element()
    }
}
