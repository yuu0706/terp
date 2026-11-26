// 画面の部品（アイコン・アイコンのボタン）。
use gpui::{AnyElement, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px, svg};

pub fn icon(name: &str, size: f32, color: Hsla) -> gpui::Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(color)
}

// アイコンだけのボタン。説明は指を置いたときに出す
pub fn icon_button(id: impl Into<ElementId>, name: &str, tip: &'static str, color: Hsla, hover_bg: Hsla, hover_fg: Hsla) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(24.0))
        .rounded_md()
        .text_color(color)
        .hover(move |s| s.bg(hover_bg).text_color(hover_fg))
        .tooltip(move |_, cx| crate::tooltip::text(tip, cx))
        .child(svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(15.0)).text_color(color))
}

// 黒一色の絵。Electron 版と同じく文字の色で塗る。ほかは元の色のまま出す
const MASK_AGENT_ICONS: [&str; 10] = ["opencode", "cursor-agent", "goose", "grok", "hermes", "cline", "kilo", "command-code", "zcode", "mimo"];

pub fn agent_icon(command: &str, size: f32, color: Hsla) -> AnyElement {
    let path = format!("agents/{command}.svg");
    if !crate::assets::has(&path) {
        icon("robot", size, color).into_any_element()
    } else if MASK_AGENT_ICONS.contains(&command) {
        svg().path(SharedString::from(path)).size(px(size)).flex_none().text_color(color).into_any_element()
    } else {
        gpui::img(SharedString::from(path)).size(px(size)).flex_none().into_any_element()
    }
}

// 窓のふちの代わりの帯。ダブルクリックで macOS の設定どおり（既定は拡大）にし、押したまま動かしたら窓を動かす。
// 押した時点で窓を動かし始めると、macOS が離すまでを移動として扱い、2回目の押下がダブルクリックにならないため、
// 動かし始めは指が動いてからにする（Zed の題名の帯と同じ）
static TITLEBAR_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn titlebar<E: InteractiveElement>(el: E) -> E {
    use std::sync::atomic::Ordering;
    el.on_mouse_down(gpui::MouseButton::Left, |event: &gpui::MouseDownEvent, window, _| {
        if event.click_count == 2 {
            TITLEBAR_ARMED.store(false, Ordering::Relaxed);
            window.titlebar_double_click();
        } else {
            TITLEBAR_ARMED.store(true, Ordering::Relaxed);
        }
    })
    .on_mouse_move(|event: &gpui::MouseMoveEvent, window, _| {
        if event.pressed_button == Some(gpui::MouseButton::Left) && TITLEBAR_ARMED.swap(false, Ordering::Relaxed) {
            window.start_window_move();
        }
    })
    .on_mouse_up(gpui::MouseButton::Left, |_, _, _| TITLEBAR_ARMED.store(false, Ordering::Relaxed))
}
