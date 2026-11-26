// タブで開いたファイル。文字は編集し、画像は閲覧する。Markdown は編集とプレビューを切り替えられる。
// 外でファイルが変わったら、未保存の変更が無ければ読み直し、あれば知らせる
use crate::appearance::{Appearance, hsla};
use crate::markdown::{Block, Inline, Mark};
use crate::syntax::{self, Tok};
use crate::textbuf::TextBuffer;
use gpui::{
    AnyElement, App, Bounds, ClickEvent, ClipboardItem, ContentMask, Context, CursorStyle, ElementId, ElementInputHandler, Entity, EntityInputHandler,
    EventEmitter, FocusHandle, Focusable, FontStyle, FontWeight, GlobalElementId, HighlightStyle, InteractiveText, KeyBinding, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollEvent, ShapedLine, SharedString, StrikethroughStyle, Style, StyledText, Task, TextRun,
    UTF16Selection, UnderlineStyle, Window, actions, div, fill, point, prelude::*, px, relative, size,
};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

actions!(
    file_editor,
    [
        MoveLeft, MoveRight, MoveUp, MoveDown, SelectLeft, SelectRight, SelectUp, SelectDown, WordLeft, WordRight, SelectWordLeft, SelectWordRight,
        LineStart, LineEnd, SelectLineStart, SelectLineEnd, DocStart, DocEnd, SelectDocStart, SelectDocEnd, PageUp, PageDown, SelectPageUp,
        SelectPageDown, Backspace, DeleteWordBack, DeleteToLineStart, DeleteForward, DeleteWordForward, Newline, Indent, Outdent, SelectAll, Copy,
        Cut, Paste, Undo, Redo, Save, TogglePreview,
    ]
);

pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some("FileEditor");
    vec![
        KeyBinding::new("left", MoveLeft, c),
        KeyBinding::new("right", MoveRight, c),
        KeyBinding::new("up", MoveUp, c),
        KeyBinding::new("down", MoveDown, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("alt-left", WordLeft, c),
        KeyBinding::new("alt-right", WordRight, c),
        KeyBinding::new("alt-shift-left", SelectWordLeft, c),
        KeyBinding::new("alt-shift-right", SelectWordRight, c),
        KeyBinding::new("cmd-left", LineStart, c),
        KeyBinding::new("home", LineStart, c),
        KeyBinding::new("ctrl-a", LineStart, c),
        KeyBinding::new("cmd-right", LineEnd, c),
        KeyBinding::new("end", LineEnd, c),
        KeyBinding::new("ctrl-e", LineEnd, c),
        KeyBinding::new("cmd-shift-left", SelectLineStart, c),
        KeyBinding::new("shift-home", SelectLineStart, c),
        KeyBinding::new("cmd-shift-right", SelectLineEnd, c),
        KeyBinding::new("shift-end", SelectLineEnd, c),
        KeyBinding::new("cmd-up", DocStart, c),
        KeyBinding::new("cmd-down", DocEnd, c),
        KeyBinding::new("cmd-shift-up", SelectDocStart, c),
        KeyBinding::new("cmd-shift-down", SelectDocEnd, c),
        KeyBinding::new("pageup", PageUp, c),
        KeyBinding::new("pagedown", PageDown, c),
        KeyBinding::new("shift-pageup", SelectPageUp, c),
        KeyBinding::new("shift-pagedown", SelectPageDown, c),
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("shift-backspace", Backspace, c),
        KeyBinding::new("alt-backspace", DeleteWordBack, c),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, c),
        KeyBinding::new("delete", DeleteForward, c),
        KeyBinding::new("ctrl-d", DeleteForward, c),
        KeyBinding::new("alt-delete", DeleteWordForward, c),
        KeyBinding::new("enter", Newline, c),
        KeyBinding::new("shift-enter", Newline, c),
        KeyBinding::new("tab", Indent, c),
        KeyBinding::new("shift-tab", Outdent, c),
        KeyBinding::new("cmd-a", SelectAll, c),
        KeyBinding::new("cmd-c", Copy, c),
        KeyBinding::new("cmd-x", Cut, c),
        KeyBinding::new("cmd-v", Paste, c),
        KeyBinding::new("cmd-z", Undo, c),
        KeyBinding::new("cmd-shift-z", Redo, c),
        KeyBinding::new("cmd-s", Save, c),
        KeyBinding::new("cmd-shift-v", TogglePreview, c),
    ]
}

#[derive(Clone, Debug, PartialEq)]
pub enum EditorEvent {
    // 未保存かどうか・題名が変わった
    Changed,
    // 外部のエディタで開く
    OpenExternal,
    // ⌘クリックしたリンクと、相対のパスを探す基準の場所（ファイルのあるフォルダ）
    OpenLink(crate::links::Target, PathBuf),
}

// これより大きいファイルは開かない
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const TAB_WIDTH: usize = 4;
const IMAGE_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tiff"];
// Markdown を最後にどちらで見たか。次に開く Markdown もそれで開く
static PREVIEW_PREFERRED: AtomicBool = AtomicBool::new(false);

enum Body {
    Text(TextBuffer),
    Image,
    Message(String),
}

struct Painted {
    bounds: Bounds<Pixels>,
    text_left: Pixels,
    line_height: Pixels,
    first_line: usize,
    lines: Vec<ShapedLine>,
}

pub struct FileEditor {
    pub path: PathBuf,
    focus: FocusHandle,
    body: Body,
    saved_text: String,
    dirty: bool,
    mtime: Option<SystemTime>,
    external_change: bool,
    error: Option<String>,
    preview: bool,
    preview_cache: Option<(u64, Vec<Block>)>,
    preview_scroll: gpui::ScrollHandle,
    states_cache: Option<(u64, Vec<bool>)>,
    scroll: Point<Pixels>,
    reveal: bool,
    marked: Option<Range<usize>>,
    selecting: bool,
    // ⌘ を押してリンクの上にいる（指の形にする）
    link_hover: bool,
    painted: Option<Painted>,
    _poll: Task<()>,
}

impl EventEmitter<EditorEvent> for FileEditor {}

impl Focusable for FileEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"))
}

fn read_body(path: &Path) -> (Body, String, Option<SystemTime>) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return (Body::Message(format!("ファイルを読めない: {e}")), String::new(), None),
    };
    let mtime = meta.modified().ok();
    if meta.is_dir() {
        return (Body::Message("フォルダは開けない".into()), String::new(), mtime);
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return (Body::Image, String::new(), mtime);
    }
    if meta.len() > MAX_BYTES {
        return (Body::Message(format!("大きすぎて開けない（{:.1} MB。上限は 5 MB）", meta.len() as f64 / 1024.0 / 1024.0)), String::new(), mtime);
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return (Body::Message(format!("ファイルを読めない: {e}")), String::new(), mtime),
    };
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return (Body::Message("文字のファイルではないため開けない".into()), String::new(), mtime);
    }
    match String::from_utf8(bytes) {
        Ok(text) => {
            let buffer = TextBuffer::new(&text);
            let saved = buffer.text().to_string();
            (Body::Text(buffer), saved, mtime)
        }
        Err(_) => (Body::Message("UTF-8 ではない文字のファイルのため開けない".into()), String::new(), mtime),
    }
}

// タブを幅 4 の空白に広げた表示の位置と、元の位置を行き来する
fn display_line(line: &str) -> String {
    line.replace('\t', &" ".repeat(TAB_WIDTH))
}

fn to_display(line: &str, index: usize) -> usize {
    index + line[..index.min(line.len())].matches('\t').count() * (TAB_WIDTH - 1)
}

fn from_display(line: &str, display: usize) -> usize {
    let mut d = 0;
    for (i, c) in line.char_indices() {
        let w = if c == '\t' { TAB_WIDTH } else { c.len_utf8() };
        if d + w > display {
            return if display - d > w / 2 && c == '\t' { i + 1 } else { i };
        }
        d += w;
    }
    line.len()
}

impl FileEditor {
    pub fn open(path: PathBuf, line: Option<usize>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (mut body, saved_text, mtime) = read_body(&path);
        if let (Body::Text(b), Some(line)) = (&mut body, line) {
            let at = b.line_start(line.saturating_sub(1));
            b.move_to(at, false);
        }
        let poll = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                if this.update(cx, |editor, cx| editor.check_external(cx)).is_err() {
                    break;
                }
            }
        });
        let preview = is_markdown(&path) && PREVIEW_PREFERRED.load(Ordering::Relaxed);
        FileEditor {
            path,
            focus: cx.focus_handle(),
            body,
            saved_text,
            dirty: false,
            mtime,
            external_change: false,
            error: None,
            preview,
            preview_cache: None,
            preview_scroll: gpui::ScrollHandle::new(),
            states_cache: None,
            scroll: point(px(0.0), px(0.0)),
            reveal: true,
            marked: None,
            selecting: false,
            link_hover: false,
            painted: None,
            _poll: poll,
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn title(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.path.display().to_string())
    }

    pub fn reveal_line(&mut self, line: usize, cx: &mut Context<Self>) {
        if let Body::Text(b) = &mut self.body {
            let at = b.line_start(line.saturating_sub(1));
            b.move_to(at, false);
            self.preview = false;
            self.reveal = true;
            cx.notify();
        }
    }

    fn buffer(&mut self) -> Option<&mut TextBuffer> {
        match &mut self.body {
            Body::Text(b) if !self.preview => Some(b),
            _ => None,
        }
    }

    fn after_change(&mut self, cx: &mut Context<Self>) {
        let Body::Text(b) = &self.body else { return };
        let dirty = b.text() != self.saved_text;
        if dirty != self.dirty {
            self.dirty = dirty;
            cx.emit(EditorEvent::Changed);
        }
        self.marked = None;
        self.reveal = true;
        cx.notify();
    }

    fn edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut TextBuffer)) {
        if let Some(b) = self.buffer() {
            f(b);
            self.after_change(cx);
        }
    }

    fn motion(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut TextBuffer)) {
        if let Some(b) = self.buffer() {
            f(b);
            self.reveal = true;
            cx.notify();
        }
    }

    fn page_rows(&self) -> isize {
        self.painted.as_ref().map(|p| ((p.bounds.size.height / p.line_height).floor() as isize - 1).max(1)).unwrap_or(20)
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let Body::Text(b) = &self.body else { return };
        let text = b.file_text();
        match std::fs::write(&self.path, &text) {
            Ok(()) => {
                self.saved_text = b.text().to_string();
                self.mtime = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
                self.external_change = false;
                self.error = None;
                self.dirty = false;
                cx.emit(EditorEvent::Changed);
            }
            Err(e) => self.error = Some(format!("保存できない: {e}")),
        }
        cx.notify();
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let (body, saved, mtime) = read_body(&self.path);
        match (&mut self.body, body) {
            (Body::Text(b), Body::Text(_)) => {
                b.reload(&saved);
                self.saved_text = saved;
            }
            (slot, body) => {
                *slot = body;
                self.saved_text = saved;
            }
        }
        self.mtime = mtime;
        self.external_change = false;
        self.error = None;
        self.dirty = false;
        cx.emit(EditorEvent::Changed);
        cx.notify();
    }

    // 外でファイルが変わったか。変わっていて未保存の変更が無ければ読み直す
    fn check_external(&mut self, cx: &mut Context<Self>) {
        let now = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if now.is_none() {
            let message = "ファイルが見つからない（消えたか移った）".to_string();
            if self.error.as_ref() != Some(&message) {
                self.error = Some(message);
                cx.notify();
            }
            return;
        }
        if now == self.mtime {
            return;
        }
        if self.dirty {
            if !self.external_change {
                self.external_change = true;
                cx.notify();
            }
            return;
        }
        self.reload(cx);
    }

    fn set_preview(&mut self, on: bool, cx: &mut Context<Self>) {
        self.preview = on;
        PREVIEW_PREFERRED.store(on, Ordering::Relaxed);
        cx.notify();
    }

    fn offset_for_point(&self, position: Point<Pixels>) -> Option<usize> {
        let Body::Text(b) = &self.body else { return None };
        let p = self.painted.as_ref()?;
        let row = ((position.y - p.bounds.top() + self.scroll.y) / p.line_height).floor().max(0.0) as usize;
        let line = row.min(b.line_count() - 1);
        let text = b.line(line);
        let x = (position.x - p.text_left + self.scroll.x).max(px(0.0));
        let display = match p.lines.get(line.wrapping_sub(p.first_line)) {
            Some(shaped) => shaped.closest_index_for_x(x),
            None => display_line(text).len(),
        };
        Some(b.line_start(line) + from_display(text, display))
    }

    // その位置のリンク（URL かファイルのパス）
    fn link_at(&self, at: usize) -> Option<crate::links::Target> {
        let Body::Text(b) = &self.body else { return None };
        let line = b.line_of(at);
        let text = b.line(line);
        let char_index = text[..at - b.line_start(line)].chars().count();
        crate::links::find(text).into_iter().find(|f| (f.start..f.end).contains(&char_index)).map(|f| f.target)
    }

    fn base_dir(&self) -> PathBuf {
        self.path.parent().map(Path::to_path_buf).unwrap_or_default()
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some(at) = self.offset_for_point(event.position) else { return };
        // ⌘クリックでリンクを開く
        if event.modifiers.platform
            && let Some(target) = self.link_at(at)
        {
            cx.emit(EditorEvent::OpenLink(target, self.base_dir()));
            return;
        }
        let count = event.click_count;
        let shift = event.modifiers.shift;
        if let Body::Text(b) = &mut self.body {
            match count {
                2 => {
                    let r = b.word_range(at);
                    b.set_selection(r, false);
                }
                n if n >= 3 => {
                    let r = b.line_range(at);
                    b.set_selection(r, false);
                }
                _ => b.move_to(at, shift),
            }
        }
        self.selecting = true;
        cx.notify();
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.pressed_button.is_none() {
            let hover = event.modifiers.platform && self.offset_for_point(event.position).and_then(|at| self.link_at(at)).is_some();
            if hover != self.link_hover {
                self.link_hover = hover;
                cx.notify();
            }
        }
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let Some(at) = self.offset_for_point(event.position)
            && let Body::Text(b) = &mut self.body
        {
            b.move_to(at, true);
            self.reveal = true;
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_scroll(&mut self, event: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(window.line_height());
        self.scroll.y = (self.scroll.y - delta.y).max(px(0.0));
        self.scroll.x = (self.scroll.x - delta.x).max(px(0.0));
        cx.stop_propagation();
        cx.notify();
    }

    fn utf16_to_offset(&self, offset: usize) -> usize {
        let Body::Text(b) = &self.body else { return 0 };
        let mut utf16 = 0;
        for (i, c) in b.text().char_indices() {
            if utf16 >= offset {
                return i;
            }
            utf16 += c.len_utf16();
        }
        b.text().len()
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let Body::Text(b) = &self.body else { return 0 };
        b.text()[..offset.min(b.text().len())].encode_utf16().count()
    }

    fn range_from_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.utf16_to_offset(r.start)..self.utf16_to_offset(r.end)
    }

    fn range_to_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(r.start)..self.offset_to_utf16(r.end)
    }

    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let a = cx.global::<Appearance>();
        let chrome = a.chrome.clone();
        let (text, muted, border, hover) = (hsla(chrome.text, 1.0), hsla(chrome.text_muted, 1.0), hsla(chrome.border, 1.0), hsla(chrome.bg_hover, 1.0));
        let button = |id: &'static str, label: &'static str| {
            div().id(id).px_2().py(px(1.0)).rounded_md().border_1().border_color(border).text_xs().text_color(text).hover(move |s| s.bg(hover)).child(label)
        };
        let shown = match self.path.strip_prefix(crate::config::home_dir()) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => self.path.display().to_string(),
        };
        let is_text = matches!(self.body, Body::Text(_));
        div()
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap_2()
            .h(px(28.0))
            .px_3()
            .border_b_1()
            .border_color(border)
            .text_xs()
            .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_color(muted).child(shown))
            .when(self.dirty, |d| d.child(div().text_color(hsla(chrome.accent, 1.0)).child("未保存")))
            .when(is_text && is_markdown(&self.path), |d| {
                d.child(button("editor-preview", if self.preview { "編集する" } else { "プレビュー" }).on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                    let on = !e.preview;
                    e.set_preview(on, cx);
                })))
            })
            .when(is_text, |d| d.child(button("editor-save", "保存（⌘S）").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.save(cx)))))
            .child(button("editor-external", "外部のエディタで開く").on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(EditorEvent::OpenExternal))))
            .into_any_element()
    }

    fn render_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let chrome = cx.global::<Appearance>().chrome.clone();
        let warning = hsla(cx.global::<Appearance>().theme.palette[3], 1.0);
        let border = hsla(chrome.border, 1.0);
        let hover = hsla(chrome.bg_hover, 1.0);
        let text = hsla(chrome.text, 1.0);
        let button = |id: &'static str, label: &'static str| {
            div().id(id).px_2().py(px(1.0)).rounded_md().border_1().border_color(border).text_xs().text_color(text).hover(move |s| s.bg(hover)).child(label)
        };
        if let Some(error) = &self.error {
            return Some(div().flex().flex_none().px_3().py_1().text_xs().text_color(warning).border_b_1().border_color(border).child(error.clone()).into_any_element());
        }
        if !self.external_change {
            return None;
        }
        Some(
            div()
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap_2()
                .px_3()
                .py_1()
                .border_b_1()
                .border_color(border)
                .text_xs()
                .child(div().flex_1().text_color(warning).child("ファイルが外で変わった。未保存の変更がある"))
                .child(button("editor-reload", "読み直す（変更を捨てる）").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.reload(cx))))
                .child(button("editor-keep", "このまま").on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                    e.external_change = false;
                    e.mtime = std::fs::metadata(&e.path).and_then(|m| m.modified()).ok();
                    cx.notify();
                })))
                .into_any_element(),
        )
    }

    fn render_preview(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Body::Text(b) = &self.body else { return div().into_any_element() };
        let version = b.version;
        if self.preview_cache.as_ref().is_none_or(|(v, _)| *v != version) {
            self.preview_cache = Some((version, crate::markdown::parse(b.text())));
        }
        let blocks = self.preview_cache.as_ref().map(|(_, b)| b.clone()).unwrap_or_default();
        let base = self.base_dir();
        let mut counter = 0usize;
        let ctx = PreviewCtx { editor: cx.entity().downgrade(), base: base.clone() };
        let items: Vec<AnyElement> = blocks.iter().map(|block| div().max_w(px(820.0)).child(render_block(block, &ctx, &mut counter, cx)).into_any_element()).collect();
        div()
            .id("md-preview")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.preview_scroll)
            .flex()
            .flex_col()
            .gap_3()
            .px_6()
            .py_4()
            .text_color(hsla(cx.global::<Appearance>().chrome.text, 1.0))
            .children(items)
            .into_any_element()
    }

    // プレビューのリンクを開く。ページ内（#見出し）は送り、URL は外で、ファイルはタブで開く
    fn open_preview_link(&mut self, href: &str, cx: &mut Context<Self>) {
        if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
            cx.open_url(href);
            return;
        }
        if let Some(anchor) = href.strip_prefix('#') {
            self.scroll_to_heading(&percent_decode(anchor));
            cx.notify();
            return;
        }
        if href.contains("://") {
            return;
        }
        let path = href.split('#').next().unwrap_or("");
        if path.is_empty() {
            return;
        }
        let target = crate::links::Target::Path { path: percent_decode(path), line: None, column: None, shorter: Vec::new() };
        cx.emit(EditorEvent::OpenLink(target, self.base_dir()));
    }

    fn scroll_to_heading(&self, anchor: &str) {
        let Some((_, blocks)) = &self.preview_cache else { return };
        let mut seen = std::collections::HashMap::new();
        for (index, block) in blocks.iter().enumerate() {
            if let Block::Heading(_, inline) = block
                && slugify(&inline.text, &mut seen) == anchor
            {
                self.preview_scroll.scroll_to_item(index);
                return;
            }
        }
    }
}

struct PreviewCtx {
    editor: gpui::WeakEntity<FileEditor>,
    base: PathBuf,
}

// GitHub の見出しの id と同じく、小文字にし、記号を除き、空白を - にする。同じ見出しには -1, -2 を付ける
fn slugify(text: &str, seen: &mut std::collections::HashMap<String, usize>) -> String {
    let base: String = text.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-').map(|c| if c.is_whitespace() { '-' } else { c }).collect();
    let count = seen.entry(base.clone()).or_insert(0);
    let slug = if *count == 0 { base.clone() } else { format!("{base}-{count}") };
    *count += 1;
    slug
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

fn inline_element(inline: &Inline, id: usize, ctx: &PreviewCtx, cx: &App) -> AnyElement {
    let a = cx.global::<Appearance>();
    let accent = hsla(a.chrome.accent, 1.0);
    let code_bg = hsla(a.chrome.bg_hover, 1.0);
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    for (range, mark) in &inline.spans {
        let style = match mark {
            Mark::Bold => HighlightStyle { font_weight: Some(FontWeight::BOLD), ..Default::default() },
            Mark::Italic => HighlightStyle { font_style: Some(FontStyle::Italic), ..Default::default() },
            Mark::Code => HighlightStyle { background_color: Some(code_bg), ..Default::default() },
            Mark::Strike => HighlightStyle { strikethrough: Some(StrikethroughStyle { thickness: px(1.0), color: None }), ..Default::default() },
            Mark::Link(url) => {
                links.push((range.clone(), url.clone()));
                HighlightStyle { color: Some(accent), underline: Some(UnderlineStyle { thickness: px(1.0), color: Some(accent), wavy: false }), ..Default::default() }
            }
        };
        highlights.push((range.clone(), style));
    }
    // 重なる範囲は描けないため、始まりの順に並べ、前と重なるものは外す
    highlights.sort_by_key(|(r, _)| r.start);
    let mut end = 0;
    highlights.retain(|(r, _)| {
        let keep = r.start >= end;
        if keep {
            end = r.end;
        }
        keep
    });
    let styled = StyledText::new(inline.text.clone()).with_highlights(highlights);
    if links.is_empty() {
        return styled.into_any_element();
    }
    let ranges: Vec<Range<usize>> = links.iter().map(|(r, _)| r.clone()).collect();
    let editor = ctx.editor.clone();
    InteractiveText::new(ElementId::Name(format!("md-text-{id}").into()), styled)
        .on_click(ranges, move |index, _, cx| {
            let href = links[index].1.clone();
            let _ = editor.update(cx, |e, cx| e.open_preview_link(&href, cx));
        })
        .into_any_element()
}

fn render_block(block: &Block, ctx: &PreviewCtx, counter: &mut usize, cx: &App) -> AnyElement {
    *counter += 1;
    let id = *counter;
    let a = cx.global::<Appearance>();
    let (muted, border, code_bg) = (hsla(a.chrome.text_muted, 1.0), hsla(a.chrome.border, 1.0), hsla(a.chrome.bg_hover, 1.0));
    let mono = a.font.family.clone();
    match block {
        Block::Heading(level, inline) => {
            let size = match level {
                1 => 26.0,
                2 => 21.0,
                3 => 18.0,
                _ => 15.0,
            };
            div()
                .text_size(px(size))
                .font_weight(FontWeight::BOLD)
                .when(*level <= 2, |d| d.pb_1().border_b_1().border_color(border))
                .child(inline_element(inline, id, ctx, cx))
                .into_any_element()
        }
        Block::Para(inline) => div().line_height(relative(1.6)).child(inline_element(inline, id, ctx, cx)).into_any_element(),
        Block::Code(code) => div().p_3().rounded_md().bg(code_bg).font_family(mono).text_sm().child(code.clone()).into_any_element(),
        Block::Quote(blocks) => div()
            .flex()
            .flex_col()
            .gap_2()
            .pl_3()
            .border_l_4()
            .border_color(border)
            .text_color(muted)
            .children(blocks.iter().map(|b| render_block(b, ctx, counter, cx)))
            .into_any_element(),
        Block::List { start, items } => {
            let mut list = div().flex().flex_col().gap_1();
            for (i, item) in items.iter().enumerate() {
                let marker = match start {
                    Some(n) => format!("{}.", n + i as u64),
                    None => "•".into(),
                };
                list = list.child(
                    div()
                        .flex()
                        .flex_row()
                        .gap_2()
                        .child(div().flex_none().min_w(px(18.0)).text_color(muted).child(marker))
                        .child(div().flex_1().min_w_0().flex().flex_col().gap_1().children(item.iter().map(|b| render_block(b, ctx, counter, cx)))),
                );
            }
            list.into_any_element()
        }
        Block::Table(rows) => {
            let mut table = div().flex().flex_col().border_1().border_color(border).rounded_md();
            for (r, row) in rows.iter().enumerate() {
                let mut line = div().flex().flex_row().when(r > 0, |d| d.border_t_1().border_color(border)).when(r == 0, |d| d.font_weight(FontWeight::SEMIBOLD).bg(code_bg));
                for (c, cell) in row.iter().enumerate() {
                    *counter += 1;
                    line = line.child(div().flex_1().min_w_0().px_2().py_1().when(c > 0, |d| d.border_l_1().border_color(border)).child(inline_element(cell, *counter, ctx, cx)));
                }
                table = table.child(line);
            }
            table.into_any_element()
        }
        Block::Image { src, alt } => {
            if src.starts_with("http://") || src.starts_with("https://") {
                return div().text_color(muted).child(format!("［画像: {alt}］")).into_any_element();
            }
            let path = if Path::new(src).is_absolute() { PathBuf::from(src) } else { ctx.base.join(percent_decode(src)) };
            div().max_w_full().child(gpui::img(path).max_w_full()).into_any_element()
        }
        Block::Rule => div().h(px(1.0)).bg(border).into_any_element(),
    }
}

impl EntityInputHandler for FileEditor {
    fn text_for_range(&mut self, range: Range<usize>, actual: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let range = self.range_from_utf16(&range);
        actual.replace(self.range_to_utf16(&range));
        let Body::Text(b) = &self.body else { return None };
        Some(b.text()[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let Body::Text(b) = &self.body else { return None };
        let (range, reversed) = (b.selected.clone(), b.reversed);
        Some(UTF16Selection { range: self.range_to_utf16(&range), reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone());
        self.edit(cx, |b| {
            let range = range.unwrap_or(b.selected.clone());
            b.replace(range, text);
        });
    }

    fn replace_and_mark_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, new_selected: Option<Range<usize>>, _: &mut Window, cx: &mut Context<Self>) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone());
        let Some(b) = self.buffer() else { return };
        let range = range.unwrap_or(b.selected.clone());
        let start = range.start;
        b.replace(range, text);
        let marked = (!text.is_empty()).then(|| start..start + text.len());
        if let Some(sel) = new_selected {
            let chars: Vec<(usize, char)> = text.char_indices().collect();
            let to_byte = |u: usize| {
                let mut n = 0;
                for (i, c) in &chars {
                    if n >= u {
                        return *i;
                    }
                    n += c.len_utf16();
                }
                text.len()
            };
            b.set_selection(start + to_byte(sel.start)..start + to_byte(sel.end), false);
        }
        self.after_change(cx);
        self.marked = marked;
    }

    fn bounds_for_range(&mut self, range: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range);
        let Body::Text(b) = &self.body else { return None };
        let p = self.painted.as_ref()?;
        let line = b.line_of(range.start);
        let shaped = p.lines.get(line.checked_sub(p.first_line)?)?;
        let text = b.line(line);
        let start = b.line_start(line);
        let x = shaped.x_for_index(to_display(text, range.start - start));
        let top = p.bounds.top() + p.line_height * line as f32 - self.scroll.y;
        Some(Bounds::new(point(p.text_left + x - self.scroll.x, top), size(px(2.0), p.line_height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let at = self.offset_for_point(point)?;
        Some(self.offset_to_utf16(at))
    }
}

impl Render for FileEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let chrome = cx.global::<Appearance>().chrome.clone();
        let header = self.render_header(cx);
        let banner = self.render_banner(cx);
        let body: AnyElement = match &self.body {
            Body::Message(message) => div().flex().flex_1().items_center().justify_center().text_color(hsla(chrome.text_muted, 1.0)).child(message.clone()).into_any_element(),
            Body::Image => div().flex().flex_1().min_h_0().items_center().justify_center().p_4().child(gpui::img(self.path.clone()).max_w_full().max_h_full()).into_any_element(),
            Body::Text(_) if self.preview => self.render_preview(cx),
            Body::Text(_) => div()
                .id("editor-text")
                .flex_1()
                .min_h_0()
                .cursor(if self.link_hover { CursorStyle::PointingHand } else { CursorStyle::IBeam })
                .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                .on_mouse_move(cx.listener(Self::on_mouse_move))
                .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                .on_scroll(cx.listener(Self::on_scroll))
                .child(EditorElement { editor: cx.entity() })
                .into_any_element(),
        };
        div()
            .key_context("FileEditor")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .on_action(cx.listener(|e, _: &MoveLeft, _, cx| e.motion(cx, |b| b.left(false, false))))
            .on_action(cx.listener(|e, _: &MoveRight, _, cx| e.motion(cx, |b| b.right(false, false))))
            .on_action(cx.listener(|e, _: &MoveUp, _, cx| e.motion(cx, |b| b.vertical(-1, false))))
            .on_action(cx.listener(|e, _: &MoveDown, _, cx| e.motion(cx, |b| b.vertical(1, false))))
            .on_action(cx.listener(|e, _: &SelectLeft, _, cx| e.motion(cx, |b| b.left(true, false))))
            .on_action(cx.listener(|e, _: &SelectRight, _, cx| e.motion(cx, |b| b.right(true, false))))
            .on_action(cx.listener(|e, _: &SelectUp, _, cx| e.motion(cx, |b| b.vertical(-1, true))))
            .on_action(cx.listener(|e, _: &SelectDown, _, cx| e.motion(cx, |b| b.vertical(1, true))))
            .on_action(cx.listener(|e, _: &WordLeft, _, cx| e.motion(cx, |b| b.left(false, true))))
            .on_action(cx.listener(|e, _: &WordRight, _, cx| e.motion(cx, |b| b.right(false, true))))
            .on_action(cx.listener(|e, _: &SelectWordLeft, _, cx| e.motion(cx, |b| b.left(true, true))))
            .on_action(cx.listener(|e, _: &SelectWordRight, _, cx| e.motion(cx, |b| b.right(true, true))))
            .on_action(cx.listener(|e, _: &LineStart, _, cx| e.motion(cx, |b| b.home(false))))
            .on_action(cx.listener(|e, _: &LineEnd, _, cx| e.motion(cx, |b| b.end(false))))
            .on_action(cx.listener(|e, _: &SelectLineStart, _, cx| e.motion(cx, |b| b.home(true))))
            .on_action(cx.listener(|e, _: &SelectLineEnd, _, cx| e.motion(cx, |b| b.end(true))))
            .on_action(cx.listener(|e, _: &DocStart, _, cx| e.motion(cx, |b| b.doc_edge(false, false))))
            .on_action(cx.listener(|e, _: &DocEnd, _, cx| e.motion(cx, |b| b.doc_edge(true, false))))
            .on_action(cx.listener(|e, _: &SelectDocStart, _, cx| e.motion(cx, |b| b.doc_edge(false, true))))
            .on_action(cx.listener(|e, _: &SelectDocEnd, _, cx| e.motion(cx, |b| b.doc_edge(true, true))))
            .on_action(cx.listener(|e, _: &PageUp, _, cx| {
                let rows = e.page_rows();
                e.motion(cx, |b| b.vertical(-rows, false))
            }))
            .on_action(cx.listener(|e, _: &PageDown, _, cx| {
                let rows = e.page_rows();
                e.motion(cx, |b| b.vertical(rows, false))
            }))
            .on_action(cx.listener(|e, _: &SelectPageUp, _, cx| {
                let rows = e.page_rows();
                e.motion(cx, |b| b.vertical(-rows, true))
            }))
            .on_action(cx.listener(|e, _: &SelectPageDown, _, cx| {
                let rows = e.page_rows();
                e.motion(cx, |b| b.vertical(rows, true))
            }))
            .on_action(cx.listener(|e, _: &Backspace, _, cx| e.edit(cx, |b| b.backspace(false, false))))
            .on_action(cx.listener(|e, _: &DeleteWordBack, _, cx| e.edit(cx, |b| b.backspace(true, false))))
            .on_action(cx.listener(|e, _: &DeleteToLineStart, _, cx| e.edit(cx, |b| b.backspace(false, true))))
            .on_action(cx.listener(|e, _: &DeleteForward, _, cx| e.edit(cx, |b| b.delete_forward(false))))
            .on_action(cx.listener(|e, _: &DeleteWordForward, _, cx| e.edit(cx, |b| b.delete_forward(true))))
            .on_action(cx.listener(|e, _: &Newline, _, cx| e.edit(cx, |b| b.newline())))
            .on_action(cx.listener(|e, _: &Indent, _, cx| e.edit(cx, |b| b.indent())))
            .on_action(cx.listener(|e, _: &Outdent, _, cx| e.edit(cx, |b| b.outdent())))
            .on_action(cx.listener(|e, _: &SelectAll, _, cx| e.motion(cx, |b| b.select_all())))
            .on_action(cx.listener(|e, _: &Copy, _, cx| {
                if let Body::Text(b) = &e.body
                    && !b.selected.is_empty()
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(b.selected_text().to_string()));
                }
            }))
            .on_action(cx.listener(|e, _: &Cut, _, cx| {
                if let Some(b) = e.buffer()
                    && !b.selected.is_empty()
                {
                    let text = b.selected_text().to_string();
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    e.edit(cx, |b| b.insert(""));
                }
            }))
            .on_action(cx.listener(|e, _: &Paste, _, cx| {
                if let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) {
                    e.edit(cx, |b| b.insert(&text));
                }
            }))
            .on_action(cx.listener(|e, _: &Undo, _, cx| e.edit(cx, |b| {
                b.undo();
            })))
            .on_action(cx.listener(|e, _: &Redo, _, cx| e.edit(cx, |b| {
                b.redo();
            })))
            .on_action(cx.listener(|e, _: &Save, _, cx| e.save(cx)))
            .on_action(cx.listener(|e, _: &TogglePreview, _, cx| {
                if is_markdown(&e.path) {
                    let on = !e.preview;
                    e.set_preview(on, cx);
                }
            }))
            .child(header)
            .children(banner)
            .child(body)
    }
}

struct EditorElement {
    editor: Entity<FileEditor>,
}

pub struct EditorPrepaint {
    text_bounds: Bounds<Pixels>,
    gutter: Vec<(Pixels, ShapedLine)>,
    lines: Vec<(Pixels, ShapedLine)>,
    selection: Vec<gpui::PaintQuad>,
    current_line: Option<gpui::PaintQuad>,
    cursor: Option<gpui::PaintQuad>,
}

impl gpui::Element for EditorElement {
    type RequestLayoutState = ();
    type PrepaintState = EditorPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> EditorPrepaint {
        let a = cx.global::<Appearance>();
        let (theme, chrome, font, font_size) = (a.theme.clone(), a.chrome.clone(), a.font.clone(), a.font_size);
        let line_height = (font_size * 1.45).round();
        let color_of = |tok: Option<Tok>| match tok {
            None => hsla(theme.foreground, 1.0),
            Some(Tok::Comment) => hsla(theme.palette[8], 1.0),
            Some(Tok::Keyword) => hsla(theme.palette[5], 1.0),
            Some(Tok::Str) => hsla(theme.palette[2], 1.0),
            Some(Tok::Number) => hsla(theme.palette[3], 1.0),
            Some(Tok::Type) => hsla(theme.palette[6], 1.0),
            Some(Tok::Tag) => hsla(theme.palette[4], 1.0),
            Some(Tok::Heading) => hsla(theme.palette[4], 1.0),
        };
        let run = |len: usize, color, underline: bool| TextRun {
            len,
            font: font.clone(),
            color,
            background_color: None,
            underline: underline.then_some(UnderlineStyle { color: Some(color), thickness: px(1.0), wavy: false }),
            strikethrough: None,
        };
        let shape = |window: &mut Window, text: String, runs: Vec<TextRun>| window.text_system().shape_line(SharedString::from(text), font_size, &runs, None);

        let editor = self.editor.clone();
        let lang = syntax::lang_for(&editor.read(cx).path);
        // 複数行の注釈の状態は、書き換えたときだけ数え直す
        editor.update(cx, |e, _| {
            if let (Body::Text(b), Some(lang)) = (&e.body, lang)
                && e.states_cache.as_ref().is_none_or(|(v, _)| *v != b.version)
            {
                let states = syntax::block_states((0..b.line_count()).map(|l| b.line(l)), lang);
                e.states_cache = Some((b.version, states));
            }
        });
        let e = editor.read(cx);
        let Body::Text(b) = &e.body else {
            return EditorPrepaint { text_bounds: bounds, gutter: Vec::new(), lines: Vec::new(), selection: Vec::new(), current_line: None, cursor: None };
        };
        let line_count = b.line_count();
        let digits = line_count.to_string().len().max(3);
        let char_w = shape(window, "0".into(), vec![run(1, hsla(theme.foreground, 1.0), false)]).width;
        let gutter_w = char_w * digits as f32 + px(24.0);
        let text_left = bounds.left() + gutter_w;
        let text_bounds = Bounds::from_corners(point(text_left, bounds.top()), bounds.bottom_right());
        let visible_rows = (bounds.size.height / line_height).ceil() as usize + 1;

        // 縦の送りを決める。カーソルを見せるときは、カーソルの行が見える所まで送る
        let cursor = b.cursor();
        let cursor_line = b.line_of(cursor);
        let mut scroll = e.scroll;
        let max_y = (line_height * line_count as f32 - line_height * 3.0).max(px(0.0));
        if e.reveal {
            let top = line_height * cursor_line as f32;
            if top < scroll.y {
                scroll.y = top;
            } else if top + line_height > scroll.y + bounds.size.height {
                scroll.y = top + line_height - bounds.size.height;
            }
        }
        scroll.y = scroll.y.clamp(px(0.0), max_y.max(scroll.y.min(line_height * line_count as f32)));
        scroll.y = scroll.y.min(max_y);
        let first = (scroll.y / line_height).floor() as usize;
        let last = (first + visible_rows).min(line_count);
        let states = e.states_cache.as_ref().map(|(_, s)| s.clone());

        let mut shaped_lines = Vec::new();
        let mut gutter = Vec::new();
        let muted = hsla(chrome.text_muted, 0.7);
        let current = hsla(chrome.text, 1.0);
        for line in first..last {
            let text = b.line(line);
            let y = bounds.top() + line_height * line as f32 - scroll.y;
            let number = (line + 1).to_string();
            let pad = digits - number.len();
            let label = format!("{}{}", " ".repeat(pad), number);
            let label_len = label.len();
            gutter.push((y, shape(window, label, vec![run(label_len, if line == cursor_line { current } else { muted }, false)])));
            let display = display_line(text);
            let mut colors: Vec<Option<Tok>> = vec![None; text.len()];
            if let Some(lang) = lang {
                let mut inside = states.as_ref().and_then(|s| s.get(line).copied()).unwrap_or(false);
                for (range, tok) in syntax::highlight_line(text, lang, &mut inside) {
                    for c in &mut colors[range.start.min(text.len())..range.end.min(text.len())] {
                        *c = Some(tok);
                    }
                }
            }
            // 元の位置ごとの色を、表示の位置の連なりにまとめる
            let line_start = b.line_start(line);
            let marked = e.marked.clone().filter(|m| m.start < line_start + text.len() && m.end > line_start).map(|m| m.start.max(line_start) - line_start..m.end.min(line_start + text.len()) - line_start);
            let mut runs: Vec<TextRun> = Vec::new();
            let mut last_key: Option<(Option<Tok>, bool)> = None;
            for (i, c) in text.char_indices() {
                let w = if c == '\t' { TAB_WIDTH } else { c.len_utf8() };
                let key = (colors[i], marked.as_ref().is_some_and(|m| m.contains(&i)));
                if last_key == Some(key)
                    && let Some(r) = runs.last_mut()
                {
                    r.len += w;
                } else {
                    runs.push(run(w, color_of(key.0), key.1));
                    last_key = Some(key);
                }
            }
            let shaped = shape(window, display, runs);
            shaped_lines.push((y, shaped));
        }

        // 横の送り。カーソルを見せるときは、カーソルの桁が見える所まで送る
        let text_width = text_bounds.size.width - px(8.0);
        if e.reveal
            && let Some((_, shaped)) = shaped_lines.get(cursor_line.wrapping_sub(first))
        {
            let text = b.line(cursor_line);
            let x = shaped.x_for_index(to_display(text, cursor - b.line_start(cursor_line)));
            if x < scroll.x {
                scroll.x = (x - char_w * 4.0).max(px(0.0));
            } else if x > scroll.x + text_width {
                scroll.x = x - text_width + char_w * 4.0;
            }
        }
        let widest = shaped_lines.iter().map(|(_, s)| s.width).fold(px(0.0), |a, b| a.max(b));
        if !e.reveal {
            scroll.x = scroll.x.min((widest - text_width + char_w * 4.0).max(px(0.0)));
        }

        let x_at = |offset: usize| -> Option<(Pixels, Pixels)> {
            let line = b.line_of(offset);
            let (y, shaped) = shaped_lines.get(line.checked_sub(first)?)?;
            let text = b.line(line);
            Some((text_left + shaped.x_for_index(to_display(text, offset - b.line_start(line))) - scroll.x, *y))
        };
        let selection_color = hsla(chrome.selection, 1.0);
        let mut selection = Vec::new();
        let mut cursor_quad = None;
        let mut current_line = None;
        if b.selected.is_empty() {
            if let Some((x, y)) = x_at(cursor) {
                cursor_quad = Some(fill(Bounds::new(point(x, y), size(px(2.0), line_height)), hsla(chrome.accent, 1.0)));
                current_line = Some(fill(Bounds::new(point(bounds.left(), y), size(bounds.size.width, line_height)), hsla(chrome.bg_hover, 0.5)));
            }
        } else {
            let (s, t) = (b.selected.start, b.selected.end);
            let (l1, l2) = (b.line_of(s).max(first), b.line_of(t).min(last.saturating_sub(1)));
            for line in l1..=l2 {
                let Some((y, shaped)) = shaped_lines.get(line - first) else { continue };
                let text = b.line(line);
                let ls = b.line_start(line);
                let from = if line == b.line_of(s) { shaped.x_for_index(to_display(text, s - ls)) } else { px(0.0) };
                let to = if line == b.line_of(t) { shaped.x_for_index(to_display(text, t - ls)) } else { shaped.width + char_w };
                selection.push(fill(Bounds::from_corners(point(text_left + from - scroll.x, *y), point(text_left + to - scroll.x, *y + line_height)), selection_color));
            }
        }
        let shaped_only: Vec<ShapedLine> = shaped_lines.iter().map(|(_, s)| s.clone()).collect();
        editor.update(cx, |e, _| {
            e.scroll = scroll;
            e.reveal = false;
            e.painted = Some(Painted { bounds, text_left, line_height, first_line: first, lines: shaped_only });
        });
        let lines = shaped_lines.into_iter().map(|(y, s)| (y, s)).collect();
        EditorPrepaint { text_bounds, gutter, lines, selection, current_line, cursor: cursor_quad }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), prepaint: &mut EditorPrepaint, window: &mut Window, cx: &mut App) {
        let focus = self.editor.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);
        let Some(line_height) = self.editor.read(cx).painted.as_ref().map(|p| p.line_height) else { return };
        let scroll_x = self.editor.read(cx).scroll.x;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if let Some(q) = prepaint.current_line.take() {
                window.paint_quad(q);
            }
            for (y, label) in &prepaint.gutter {
                let _ = label.paint(point(bounds.left() + px(8.0), *y), line_height, gpui::TextAlign::Left, None, window, cx);
            }
        });
        let text_bounds = prepaint.text_bounds;
        window.with_content_mask(Some(ContentMask { bounds: text_bounds }), |window| {
            for q in prepaint.selection.drain(..) {
                window.paint_quad(q);
            }
            for (y, line) in &prepaint.lines {
                let _ = line.paint(point(text_bounds.left() - scroll_x, *y), line_height, gpui::TextAlign::Left, None, window, cx);
            }
            if focus.is_focused(window)
                && let Some(q) = prepaint.cursor.take()
            {
                window.paint_quad(q);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn タブは幅4に広げ_表示の位置と元の位置を行き来する() {
        let line = "\ta\tb";
        assert_eq!(display_line(line), "    a    b");
        assert_eq!(to_display(line, 1), 4);
        assert_eq!(to_display(line, 3), 9);
        assert_eq!(from_display(line, 4), 1);
        assert_eq!(from_display(line, 1), 0);
        assert_eq!(from_display(line, 3), 1);
        assert_eq!(from_display(line, 9), 3);
        assert_eq!(from_display(line, 99), line.len());
    }

    #[test]
    fn 見出しの_id_は_github_と同じ形にする() {
        let mut seen = std::collections::HashMap::new();
        assert_eq!(slugify("Hello World!", &mut seen), "hello-world");
        assert_eq!(slugify("Hello World", &mut seen), "hello-world-1");
        assert_eq!(slugify("設定の 読み方", &mut seen), "設定の-読み方");
        assert_eq!(percent_decode("%E8%A8%AD%E5%AE%9A"), "設定");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn 文字でないファイルと大きいファイルは開かない() {
        let dir = std::env::temp_dir().join(format!("terp-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("a.bin");
        std::fs::write(&binary, [0u8, 1, 2]).unwrap();
        assert!(matches!(read_body(&binary).0, Body::Message(_)));
        let text = dir.join("a.txt");
        std::fs::write(&text, "x\r\ny").unwrap();
        let (body, saved, _) = read_body(&text);
        assert!(matches!(body, Body::Text(_)));
        assert_eq!(saved, "x\ny");
        assert!(matches!(read_body(&dir.join("p.png")).0, Body::Message(_) | Body::Image));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
