// 枠のタブで開いたファイル。端末と同じ番号の並びに入り、枠の間を動かせる。
// 開き直したときには戻さない（端末だけを控えに残す）
use crate::app::{Palette, TerpApp};
use crate::editor::{EditorEvent, FileEditor};
use crate::overlay::DialogSpec;
use gpui::{AnyElement, ClickEvent, Context, Entity, Focusable, MouseButton, MouseDownEvent, SharedString, Subscription, Window, div, prelude::*, px};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};

// 未保存のファイルの数。終了するときの確かめに使う
pub static UNSAVED: AtomicUsize = AtomicUsize::new(0);

pub struct FileTab {
    pub id: u64,
    pub editor: Entity<FileEditor>,
    pub workspace: String,
    _subscription: Subscription,
}

impl TerpApp {
    pub(crate) fn file_tab(&self, id: u64) -> Option<&FileTab> {
        self.files.iter().find(|f| f.id == id)
    }

    fn count_unsaved(&self, cx: &gpui::App) {
        UNSAVED.store(self.files.iter().filter(|f| f.editor.read(cx).is_dirty()).count(), Ordering::Relaxed);
    }

    // ファイルをタブで開く。同じワークスペースで開いていれば、そのタブへ移る
    pub(crate) fn open_file_tab(&mut self, path: PathBuf, line: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let workspace = self.workspace();
        let existing = self.files.iter().find(|f| f.workspace == workspace && f.editor.read(cx).path == path).map(|t| (t.id, t.editor.clone()));
        if let Some((id, editor)) = existing {
            if let Some(line) = line {
                editor.update(cx, |e, cx| e.reveal_line(line, cx));
            }
            self.select(id, window, cx);
            return;
        }
        let id = self.create_file_tab(path, line, workspace, window, cx);
        self.layout_mut().show_tab(id);
        self.select(id, window, cx);
    }

    // タブの中身だけを作る（枠には入れない）。開き直したときにも使う
    pub(crate) fn create_file_tab(&mut self, path: PathBuf, line: Option<usize>, workspace: String, window: &mut Window, cx: &mut Context<Self>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let editor = cx.new(|cx| FileEditor::open(path, line, window, cx));
        let subscription = cx.subscribe_in(&editor, window, move |app, editor, event, window, cx| match event {
            EditorEvent::Changed => {
                app.count_unsaved(cx);
                cx.notify();
            }
            EditorEvent::OpenLink(target, base) => app.open_editor_link(target.clone(), base.clone(), window, cx),
            EditorEvent::OpenExternal => {
                let path = editor.read(cx).path.clone();
                let config = cx.global::<crate::appearance::Appearance>().config.editor.clone();
                let path_var = crate::git::login_env().get("PATH").cloned().unwrap_or_default();
                crate::links::open_file(&crate::links::Resolved { path, directory: false, line: None, column: None }, &config, &path_var);
            }
        });
        self.files.push(FileTab { id, editor, workspace, _subscription: subscription });
        id
    }

    // 編集の画面のリンクを開く。URL は外で、ファイルはタブで、フォルダは Finder で開く
    fn open_editor_link(&mut self, target: crate::links::Target, base: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if let crate::links::Target::Url(url) = &target {
            cx.open_url(url);
            return;
        }
        match crate::links::resolve(&target, &base, None, &crate::config::home_dir()) {
            Some(r) if r.directory => cx.open_with_system(&r.path),
            Some(r) => self.open_file_tab(r.path, r.line.map(|l| l as usize), window, cx),
            None => self.show_toast("リンクのファイルが見つからない".into(), cx),
        }
    }

    pub(crate) fn select_file(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.file_tab(id) else { return };
        let (workspace, editor) = (tab.workspace.clone(), tab.editor.clone());
        if workspace != self.workspace() {
            self.set_workspace(&workspace, window, cx);
        }
        let previous = self.active_id();
        self.layout_mut().show_tab(id);
        if let Some(previous) = previous
            && previous != id
        {
            self.recent.retain(|r| *r != previous);
            self.recent.push(previous);
        }
        let handle = editor.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        cx.notify();
    }

    // 未保存の変更があれば確かめてから閉じる
    pub(crate) fn close_file(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.file_tab(id) else { return };
        let editor = tab.editor.read(cx);
        if editor.is_dirty() {
            let spec = DialogSpec {
                title: format!("{} を保存せずに閉じますか？", editor.title()),
                body: vec!["保存していない変更は消える".into()],
                fields: Vec::new(),
                choice: None,
                confirm: "保存せずに閉じる".into(),
                danger: true,
                blocked: None,
            };
            self.open_dialog(
                spec,
                Rc::new(move |app, _, _, window, cx| {
                    app.drop_file(id, window, cx);
                    Ok(())
                }),
                window,
                cx,
            );
            return;
        }
        self.drop_file(id, window, cx);
    }

    fn drop_file(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.file_tab(id).map(|t| t.workspace.clone()) else { return };
        let was_active = self.active_id() == Some(id);
        let recent = self.recent.clone();
        if let Some(layout) = self.layouts.get_mut(&workspace) {
            layout.remove_tab(id, &recent);
        }
        self.files.retain(|f| f.id != id);
        self.recent.retain(|r| *r != id);
        self.count_unsaved(cx);
        if was_active {
            match self.active_id() {
                Some(next) => self.select(next, window, cx),
                None => window.focus(&self.focus, cx),
            }
        }
        cx.notify();
    }

    pub(crate) fn render_file_tab(&self, id: u64, selected: bool, active_pane: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(tab) = self.file_tab(id) else { return div().into_any_element() };
        let editor = tab.editor.read(cx);
        let name = editor.title();
        let dirty = editor.is_dirty();
        let tip = editor.path.display().to_string();
        div()
            .id(("file-tab", id))
            .group(SharedString::from(format!("file-tab-{id}")))
            .flex()
            .flex_none()
            .flex_row()
            .items_center()
            .gap_1()
            .h(px(26.0))
            .max_w(px(240.0))
            .px_2()
            .rounded_md()
            .text_sm()
            .text_color(if selected { p.text } else { p.muted })
            .when(selected, |d| d.bg(if active_pane { p.accent_fill } else { p.accent_fill_dim }))
            .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
            .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Middle, cx.listener(move |app, _: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                app.close_file(id, window, cx);
            }))
            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
            .on_drag(crate::app::DraggedTab::new(id, name.clone()), |tab, _, _, cx| cx.new(|_| tab.clone()))
            .child(crate::ui::icon("file", 13.0, p.muted))
            .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(name))
            .child(
                div()
                    .id(("file-tab-close", id))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(16.0))
                    .rounded_sm()
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        app.close_file(id, window, cx);
                    }))
                    .when(dirty, |d| d.child(div().size(px(7.0)).rounded_full().bg(p.accent)))
                    .when(!dirty, |d| d.child(crate::ui::icon("close", 11.0, p.muted))),
            )
            .into_any_element()
    }
}
