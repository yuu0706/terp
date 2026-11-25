// 全体の一覧（⌘M）。全ワークスペースの端末を縮小した画面で並べ、検索・矢印キー・クリックで切り替える。
use crate::app::{Palette, TerpApp};
use gpui::{AnyElement, Context, Window};

pub struct Overview {}

impl TerpApp {
    pub(crate) fn toggle_overview(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.overview = if self.overview.is_some() { None } else { Some(Overview {}) };
        cx.notify();
    }
}

impl TerpApp {
    pub(crate) fn render_overview(&self, _p: &Palette, _window: &mut Window, _cx: &mut Context<Self>) -> Option<AnyElement> {
        None
    }
}
