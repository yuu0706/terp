// 画面の部品（アイコン・アイコンのボタン）。
use gpui::{AnyElement, ElementId, Hsla, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px, svg};

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
