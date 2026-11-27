// 指を置いたときに出す説明。
use crate::appearance::{Appearance, hsla};
use gpui::{AnyView, App, Context, IntoElement, Render, SharedString, Window, div, prelude::*, px};

pub struct Tooltip {
    text: SharedString,
}

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let a = cx.global::<Appearance>();
        let chrome = &a.chrome;
        div()
            .font_family(a.font.family.clone())
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(hsla(chrome.border, 1.0))
            .bg(hsla(chrome.bg_active, 1.0))
            .text_color(hsla(chrome.text, 1.0))
            .text_xs()
            .max_w(px(360.0))
            .child(self.text.clone())
    }
}

pub fn text(text: impl Into<SharedString>, cx: &mut App) -> AnyView {
    let text = text.into();
    cx.new(|_| Tooltip { text }).into()
}
