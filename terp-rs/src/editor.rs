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
        Cut, Paste, Undo, Redo, Save, TogglePreview, AddNextOccurrence, SelectAllOccurrences, AddCursorUp, AddCursorDown, CancelEditor,
        ToggleWrap, Find, FindReplace, FindNext, FindPrevious,
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
        KeyBinding::new("cmd-d", AddNextOccurrence, c),
        KeyBinding::new("cmd-shift-l", SelectAllOccurrences, c),
        KeyBinding::new("cmd-alt-up", AddCursorUp, c),
        KeyBinding::new("cmd-alt-down", AddCursorDown, c),
        KeyBinding::new("escape", CancelEditor, c),
        KeyBinding::new("alt-z", ToggleWrap, c),
        KeyBinding::new("cmd-f", Find, c),
        KeyBinding::new("cmd-alt-f", FindReplace, c),
        KeyBinding::new("cmd-g", FindNext, c),
        KeyBinding::new("cmd-shift-g", FindPrevious, c),
    ]
}

#[derive(Clone, Debug, PartialEq)]
pub enum EditorEvent {
    // 未保存かどうか・題名が変わった
    Changed,
    // 外部のエディタで開く
    OpenExternal,
    // ⌘クリックしたリンクと、相対のパスを探す基準の場所（ファイルのあるフォルダ）、⇧ を足したか
    OpenLink(crate::links::Target, PathBuf, bool),
}

// これより大きいファイルは開かない
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const TAB_WIDTH: usize = TAB;
const IMAGE_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tiff"];
// Markdown を最後にどちらで見たか。次に開く Markdown もそれで開く
static PREVIEW_PREFERRED: AtomicBool = AtomicBool::new(false);
// 長い行を折り返すか。最後に選んだほうを次に開くファイルにも使う
static WRAP_PREFERRED: AtomicBool = AtomicBool::new(false);

// ファイルの中の検索と置換
struct Search {
    query: Entity<crate::input::TextInput>,
    replace: Entity<crate::input::TextInput>,
    show_replace: bool,
    case: bool,
    word: bool,
    regex: bool,
    // 数え直す条件（版・検索の文字・選択肢）と、見つかった範囲
    key: Option<(u64, String, bool, bool, bool)>,
    matches: Vec<Range<usize>>,
    current: Option<usize>,
    error: Option<String>,
    _subs: Vec<gpui::Subscription>,
}

// 打ちかけの語の候補（ファイルの中の語から出す）
struct Completion {
    start: usize,
    items: Vec<String>,
    selected: usize,
}

enum Body {
    Text(TextBuffer),
    Image,
    Message(String),
}

struct Painted {
    bounds: Bounds<Pixels>,
    text_left: Pixels,
    line_height: Pixels,
    first_row: usize,
    // 見えている見た目の行の（元の行, 行の中の始まり, 終わり, 字形）
    rows: Vec<(usize, usize, usize, ShapedLine)>,
    // 主のカーソルの左下（候補の一覧を出す位置）
    cursor_at: Option<Point<Pixels>>,
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
    wrap: bool,
    // 折り返しの見た目の行（版・桁数ごとに作り直す）
    rows_cache: Option<(u64, usize, crate::rows::RowMap)>,
    search: Option<Search>,
    completion: Option<Completion>,
    // 選びながら枠の外へ出たときの送り（上が負）と、最後の指の位置
    drag_edge: Option<(f32, Point<Pixels>)>,
    drag_task: Option<Task<()>>,
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

use crate::rows::TAB_WIDTH as TAB;

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

// 見た目の行を rows だけ上下した位置。桁は見た目の幅で保つ
fn visual_target(map: &crate::rows::RowMap, b: &TextBuffer, offset: usize, rows: isize) -> usize {
    let line = b.line_of(offset);
    let line_start = b.line_start(line);
    let row = map.row_of(line, offset - line_start);
    let Some(&(_, start, _)) = map.rows.get(row) else { return offset };
    let col: usize = b.line(line)[start..offset - line_start].chars().map(crate::rows::char_width).sum();
    let target = row as isize + rows;
    if target < 0 {
        return 0;
    }
    let Some(&(tl, ts, te)) = map.rows.get(target as usize) else { return b.text().len() };
    let text = &b.line(tl)[ts..te];
    let mut width = 0;
    for (i, c) in text.char_indices() {
        let w = crate::rows::char_width(c);
        if width + w > col {
            return b.line_start(tl) + ts + i;
        }
        width += w;
    }
    b.line_start(tl) + te
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
            wrap: WRAP_PREFERRED.load(Ordering::Relaxed),
            rows_cache: None,
            search: None,
            completion: None,
            drag_edge: None,
            drag_task: None,
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

    // 書き換えを、どのカーソルにも当てる
    fn edit(&mut self, cx: &mut Context<Self>, f: impl Fn(&mut TextBuffer)) {
        if let Some(b) = self.buffer() {
            b.each_edit(f);
            self.completion = None;
            self.after_change(cx);
        }
    }

    fn motion(&mut self, cx: &mut Context<Self>, f: impl Fn(&mut TextBuffer)) {
        if let Some(b) = self.buffer() {
            b.each_motion(f);
            self.completion = None;
            self.reveal = true;
            cx.notify();
        }
    }

    // カーソルの数を変える操作（全体に1回だけ当てる）
    fn whole(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut TextBuffer)) {
        if let Some(b) = self.buffer() {
            f(b);
            self.completion = None;
            self.reveal = true;
            cx.notify();
        }
    }

    // ↑↓。折り返していれば見た目の行で動く
    fn move_vertical(&mut self, rows: isize, select: bool, cx: &mut Context<Self>) {
        if !self.wrap || self.preview {
            return self.motion(cx, |b| b.vertical(rows, select));
        }
        let FileEditor { body: Body::Text(b), rows_cache: Some((_, _, map)), .. } = self else {
            return self.motion(cx, |b| b.vertical(rows, select));
        };
        b.each_motion(|b| {
            let to = visual_target(map, b, b.cursor(), rows);
            b.move_to(to, select);
        });
        self.completion = None;
        self.reveal = true;
        cx.notify();
    }

    // ---- 行と見た目の行 ----

    fn row_count(&self) -> usize {
        match (&self.body, &self.rows_cache) {
            (_, Some((_, _, map))) if self.wrap => map.rows.len(),
            (Body::Text(b), _) => b.line_count(),
            _ => 0,
        }
    }

    // 見た目の行の（元の行, 行の中の始まり, 終わり）
    fn row(&self, row: usize) -> Option<(usize, usize, usize)> {
        let Body::Text(b) = &self.body else { return None };
        match &self.rows_cache {
            Some((_, _, map)) if self.wrap => map.rows.get(row).copied(),
            _ => (row < b.line_count()).then(|| (row, 0, b.line(row).len())),
        }
    }

    fn row_of(&self, offset: usize) -> usize {
        let Body::Text(b) = &self.body else { return 0 };
        let line = b.line_of(offset);
        match &self.rows_cache {
            Some((_, _, map)) if self.wrap => map.row_of(line, offset - b.line_start(line)),
            _ => line,
        }
    }

    fn set_wrap(&mut self, on: bool, cx: &mut Context<Self>) {
        self.wrap = on;
        WRAP_PREFERRED.store(on, Ordering::Relaxed);
        self.scroll.x = px(0.0);
        self.reveal = true;
        cx.notify();
    }

    // ---- 候補 ----

    // 打った直後に、カーソルの前の語（2文字以上）で始まる、ファイルの中の別の語を候補にする
    fn update_completion(&mut self) {
        self.completion = None;
        let Body::Text(b) = &self.body else { return };
        if !b.extra.is_empty() || !b.selected.is_empty() {
            return;
        }
        let at = b.cursor();
        let line_start = b.line_start(b.line_of(at));
        let before = &b.text()[line_start..at];
        let word_len: usize = before.chars().rev().take_while(|c| c.is_alphanumeric() || *c == '_').map(char::len_utf8).sum();
        if before[before.len() - word_len..].chars().count() < 2 {
            return;
        }
        let prefix = &before[before.len() - word_len..];
        let lower = prefix.to_lowercase();
        let mut items: Vec<String> = Vec::new();
        for word in b.text().split(|c: char| !(c.is_alphanumeric() || c == '_')) {
            if word.len() > prefix.len() && word.to_lowercase().starts_with(&lower) && !items.iter().any(|w| w == word) {
                items.push(word.to_string());
                if items.len() >= 200 {
                    break;
                }
            }
        }
        if items.is_empty() {
            return;
        }
        // 大文字と小文字まで合うもの、短いものを先にする
        items.sort_by_key(|w| (!w.starts_with(prefix), w.len()));
        items.truncate(10);
        self.completion = Some(Completion { start: at - word_len, items, selected: 0 });
    }

    fn accept_completion(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(c) = self.completion.take() else { return false };
        let Some(word) = c.items.get(c.selected).cloned() else { return false };
        if let Some(b) = self.buffer() {
            let at = b.cursor();
            b.replace(c.start..at, &word);
            self.after_change(cx);
        }
        true
    }

    // ---- 検索 ----

    fn open_search(&mut self, replace: bool, window: &mut Window, cx: &mut Context<Self>) {
        let selected = match &self.body {
            Body::Text(b) if !b.selected.is_empty() && !b.selected_text().contains('\n') => Some(b.selected_text().to_string()),
            _ => None,
        };
        if self.search.is_none() {
            let query = cx.new(|cx| crate::input::TextInput::new("検索", cx));
            let with = cx.new(|cx| crate::input::TextInput::new("置き換える文字", cx));
            let subs = vec![
                cx.subscribe_in(&query, window, |e, _, event, window, cx| match event {
                    crate::input::InputEvent::Changed => {
                        e.refresh_search(cx);
                        e.step_search(0, true, cx);
                    }
                    crate::input::InputEvent::Submit { shift } => e.step_search(if *shift { -1 } else { 1 }, false, cx),
                    crate::input::InputEvent::Cancel => e.close_search(window, cx),
                    _ => {}
                }),
                cx.subscribe_in(&with, window, |e, _, event, window, cx| match event {
                    crate::input::InputEvent::Submit { .. } => e.replace_current(cx),
                    crate::input::InputEvent::Cancel => e.close_search(window, cx),
                    _ => {}
                }),
            ];
            self.search = Some(Search { query, replace: with, show_replace: false, case: false, word: false, regex: false, key: None, matches: Vec::new(), current: None, error: None, _subs: subs });
        }
        let Some(search) = self.search.as_mut() else { return };
        search.show_replace |= replace;
        let query = search.query.clone();
        if let Some(text) = selected {
            query.update(cx, |i, cx| i.set_text(&text, cx));
        }
        query.update(cx, |i, cx| i.select_all_text(cx));
        let handle = query.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.refresh_search(cx);
        cx.notify();
    }

    fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    // 検索の文字・選択肢・中身が変わったときだけ、見つかる範囲を数え直す
    fn refresh_search(&mut self, cx: &mut Context<Self>) {
        let Body::Text(b) = &self.body else { return };
        let Some(search) = self.search.as_mut() else { return };
        let query = search.query.read(cx).text().to_string();
        let key = (b.version, query.clone(), search.case, search.word, search.regex);
        if search.key.as_ref() == Some(&key) {
            return;
        }
        search.key = Some(key);
        search.error = None;
        search.matches.clear();
        if query.is_empty() {
            search.current = None;
            return;
        }
        let mut pattern = if search.regex { query.clone() } else { regex::escape(&query) };
        if search.word {
            pattern = format!(r"\b(?:{pattern})\b");
        }
        match regex::RegexBuilder::new(&pattern).case_insensitive(!search.case).multi_line(true).build() {
            Ok(re) => {
                search.matches = re.find_iter(b.text()).filter(|m| !m.is_empty()).map(|m| m.range()).take(10_000).collect();
            }
            Err(_) => search.error = Some("正規表現が正しくない".into()),
        }
        let at = b.selected.start;
        search.current = search.matches.iter().position(|m| m.start >= at).or((!search.matches.is_empty()).then_some(0));
    }

    // 次（1）か前（-1）の一致へ移って選ぶ。stay なら今の位置の一致を選ぶだけ
    fn step_search(&mut self, step: isize, stay: bool, cx: &mut Context<Self>) {
        self.refresh_search(cx);
        let Some(search) = self.search.as_mut() else { return };
        let n = search.matches.len();
        if n == 0 {
            cx.notify();
            return;
        }
        let current = search.current.unwrap_or(0);
        let next = if stay { current } else { (current as isize + step).rem_euclid(n as isize) as usize };
        search.current = Some(next);
        let range = search.matches[next].clone();
        if let Body::Text(b) = &mut self.body {
            b.clear_extra();
            b.set_selection(range, false);
        }
        self.reveal = true;
        cx.notify();
    }

    fn replace_current(&mut self, cx: &mut Context<Self>) {
        self.refresh_search(cx);
        let Some(search) = self.search.as_ref() else { return };
        let Some(range) = search.current.and_then(|i| search.matches.get(i)).cloned() else { return };
        let with = search.replace.read(cx).text().to_string();
        if let Some(b) = self.buffer() {
            b.replace(range, &with);
            self.after_change(cx);
        }
        self.step_search(0, true, cx);
    }

    fn replace_all(&mut self, cx: &mut Context<Self>) {
        self.refresh_search(cx);
        let Some(search) = self.search.as_ref() else { return };
        let ranges = search.matches.clone();
        let with = search.replace.read(cx).text().to_string();
        if let Some(b) = self.buffer() {
            b.replace_all(&ranges, &with);
            self.after_change(cx);
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
        let row = (((position.y - p.bounds.top() + self.scroll.y) / p.line_height).floor().max(0.0) as usize).min(self.row_count().saturating_sub(1));
        let (line, start, end) = self.row(row)?;
        let text = &b.line(line)[start..end];
        let x = (position.x - p.text_left + self.scroll.x).max(px(0.0));
        let display = match p.rows.get(row.wrapping_sub(p.first_row)) {
            Some((_, _, _, shaped)) => shaped.closest_index_for_x(x),
            None => display_line(text).len(),
        };
        Some(b.line_start(line) + start + from_display(text, display))
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
            cx.emit(EditorEvent::OpenLink(target, self.base_dir(), event.modifiers.shift));
            return;
        }
        let count = event.click_count;
        let shift = event.modifiers.shift;
        self.completion = None;
        if let Body::Text(b) = &mut self.body {
            // ⌥クリックでカーソルを足す
            if event.modifiers.alt && count == 1 {
                b.add_cursor_at(at);
                cx.notify();
                return;
            }
            b.clear_extra();
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
        self.drag_to(event.position, cx);
        // 枠の上下の外へ出たら、出た分に応じて送り続ける
        let Some(p) = self.painted.as_ref() else { return };
        let (top, bottom) = (p.bounds.top(), p.bounds.bottom());
        let edge = if event.position.y < top {
            Some(-f32::from(top - event.position.y))
        } else if event.position.y > bottom {
            Some(f32::from(event.position.y - bottom))
        } else {
            None
        };
        match edge {
            Some(d) => {
                self.drag_edge = Some((d, event.position));
                if self.drag_task.is_none() {
                    self.drag_task = Some(cx.spawn(async move |this, cx| {
                        loop {
                            cx.background_executor().timer(Duration::from_millis(30)).await;
                            let go_on = this
                                .update(cx, |e, cx| {
                                    let Some((d, at)) = e.drag_edge.filter(|_| e.selecting) else {
                                        e.drag_task = None;
                                        return false;
                                    };
                                    let step = (d.abs() / 4.0).clamp(2.0, 40.0) * d.signum();
                                    e.scroll.y = (e.scroll.y + px(step)).max(px(0.0));
                                    e.drag_to(at, cx);
                                    true
                                })
                                .unwrap_or(false);
                            if !go_on {
                                break;
                            }
                        }
                    }));
                }
            }
            None => self.drag_edge = None,
        }
    }

    fn drag_to(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(p) = self.painted.as_ref() else { return };
        let clamped = point(position.x, position.y.clamp(p.bounds.top(), p.bounds.bottom() - px(1.0)));
        if let Some(at) = self.offset_for_point(clamped)
            && let Body::Text(b) = &mut self.body
        {
            b.move_to(at, true);
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
        self.drag_edge = None;
        self.drag_task = None;
    }

    fn on_scroll(&mut self, event: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(window.line_height());
        self.scroll.y = (self.scroll.y - delta.y).max(px(0.0));
        if !self.wrap {
            self.scroll.x = (self.scroll.x - delta.x).max(px(0.0));
        }
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
            .when(is_text && !self.preview, |d| {
                d.child(button("editor-wrap", if self.wrap { "折り返さない（⌥Z）" } else { "折り返す（⌥Z）" }).on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                    let on = !e.wrap;
                    e.set_wrap(on, cx);
                })))
            })
            .when(is_text, |d| d.child(button("editor-save", "保存（⌘S）").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.save(cx)))))
            .child(button("editor-external", "外部のエディタで開く").on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(EditorEvent::OpenExternal))))
            .into_any_element()
    }

    fn render_search(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let search = self.search.as_ref()?;
        let a = cx.global::<Appearance>();
        let chrome = a.chrome.clone();
        let (text, muted, border, hover, accent, term_bg) =
            (hsla(chrome.text, 1.0), hsla(chrome.text_muted, 1.0), hsla(chrome.border, 1.0), hsla(chrome.bg_hover, 1.0), hsla(chrome.accent, 1.0), hsla(chrome.term_bg, 1.0));
        let warning = hsla(a.theme.palette[3], 1.0);
        let button = |id: &'static str, label: &'static str| {
            div().id(id).px_2().py(px(1.0)).rounded_md().border_1().border_color(border).text_xs().text_color(text).hover(move |s| s.bg(hover)).child(label)
        };
        let toggle = |id: &'static str, label: &'static str, on: bool, tip: &'static str| {
            div()
                .id(id)
                .px_1()
                .rounded_sm()
                .text_xs()
                .border_1()
                .border_color(if on { accent } else { border })
                .text_color(if on { accent } else { muted })
                .hover(move |s| s.bg(hover))
                .tooltip(move |_, cx| crate::tooltip::text(tip, cx))
                .child(label)
        };
        let count = match (&search.error, search.matches.len(), search.current) {
            (Some(err), _, _) => err.clone(),
            (None, 0, _) => if search.query.read(cx).text().is_empty() { String::new() } else { "見つからない".into() },
            (None, n, Some(i)) => format!("{}/{n}", i + 1),
            (None, n, None) => format!("{n} 件"),
        };
        let input_box = |input: &Entity<crate::input::TextInput>| div().w(px(260.0)).px_2().py(px(2.0)).rounded_md().border_1().border_color(border).bg(term_bg).text_sm().child(input.clone());
        let show_replace = search.show_replace;
        let find_row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .child(
                div()
                    .id("search-expand")
                    .text_color(muted)
                    .hover(|s| s.text_color(text))
                    .on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                        if let Some(s) = e.search.as_mut() {
                            s.show_replace = !s.show_replace;
                        }
                        cx.notify();
                    }))
                    .child(crate::ui::icon(if show_replace { "chevron-down" } else { "chevron-right" }, 12.0, muted)),
            )
            .child(input_box(&search.query))
            .child(toggle("search-case", "Aa", search.case, "大文字と小文字を区別する").on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                if let Some(s) = e.search.as_mut() {
                    s.case = !s.case;
                }
                e.step_search(0, true, cx);
            })))
            .child(toggle("search-word", "ab", search.word, "語の全体で一致させる").on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                if let Some(s) = e.search.as_mut() {
                    s.word = !s.word;
                }
                e.step_search(0, true, cx);
            })))
            .child(toggle("search-regex", ".*", search.regex, "正規表現で探す").on_click(cx.listener(|e, _: &ClickEvent, _, cx| {
                if let Some(s) = e.search.as_mut() {
                    s.regex = !s.regex;
                }
                e.step_search(0, true, cx);
            })))
            .child(div().min_w(px(64.0)).text_xs().text_color(if search.error.is_some() { warning } else { muted }).child(count))
            .child(button("search-prev", "↑").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.step_search(-1, false, cx))))
            .child(button("search-next", "↓").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.step_search(1, false, cx))))
            .child(button("search-close", "閉じる").on_click(cx.listener(|e, _: &ClickEvent, window, cx| e.close_search(window, cx))));
        let replace_row = show_replace.then(|| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .pl(px(20.0))
                .child(input_box(&search.replace))
                .child(button("replace-one", "置き換える").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.replace_current(cx))))
                .child(button("replace-all", "すべて置き換える").on_click(cx.listener(|e, _: &ClickEvent, _, cx| e.replace_all(cx))))
        });
        Some(div().flex().flex_col().flex_none().gap_1().px_3().py_1().border_b_1().border_color(border).child(find_row).children(replace_row).into_any_element())
    }

    fn render_completion(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = self.completion.as_ref()?;
        let at = self.painted.as_ref()?.cursor_at?;
        let a = cx.global::<Appearance>();
        let chrome = a.chrome.clone();
        let mut list = div()
            .flex()
            .flex_col()
            .min_w(px(160.0))
            .max_w(px(360.0))
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(hsla(chrome.border, 1.0))
            .bg(hsla(chrome.bg, 1.0))
            .shadow_md()
            .font_family(a.font.family.clone())
            .text_sm();
        for (i, item) in c.items.iter().enumerate() {
            let selected = i == c.selected;
            list = list.child(
                div()
                    .id(("completion", i))
                    .px_2()
                    .text_color(hsla(chrome.text, 1.0))
                    .when(selected, |d| d.bg(hsla(chrome.selection, 1.0)))
                    .hover(|s| s.bg(hsla(chrome.bg_hover, 1.0)))
                    .on_click(cx.listener(move |e, _: &ClickEvent, _, cx| {
                        if let Some(c) = e.completion.as_mut() {
                            c.selected = i;
                        }
                        e.accept_completion(cx);
                    }))
                    .child(item.clone()),
            );
        }
        Some(gpui::deferred(gpui::anchored().position(at).child(list)).with_priority(2).into_any_element())
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
    fn open_preview_link(&mut self, href: &str, alternate: bool, cx: &mut Context<Self>) {
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
        cx.emit(EditorEvent::OpenLink(target, self.base_dir(), alternate));
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

// コピーする文字。カーソルが複数なら、選んだ範囲を前から順に改行でつなぐ
fn selections_text(b: &TextBuffer) -> Option<String> {
    let mut ranges: Vec<Range<usize>> = b.extra.iter().map(|c| c.range.clone()).chain(std::iter::once(b.selected.clone())).filter(|r| !r.is_empty()).collect();
    if ranges.is_empty() {
        return None;
    }
    ranges.sort_by_key(|r| r.start);
    Some(ranges.iter().map(|r| &b.text()[r.clone()]).collect::<Vec<_>>().join("\n"))
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
        .on_click(ranges, move |index, window, cx| {
            let href = links[index].1.clone();
            let alternate = window.modifiers().shift;
            let _ = editor.update(cx, |e, cx| e.open_preview_link(&href, alternate, cx));
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
        match range {
            Some(range) => {
                let Some(b) = self.buffer() else { return };
                b.replace(range, text);
                self.after_change(cx);
            }
            None => self.edit(cx, |b| b.insert(text)),
        }
        self.update_completion();
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
        let row = self.row_of(range.start);
        let (line, start, end, shaped) = p.rows.get(row.checked_sub(p.first_row)?)?;
        let text = &b.line(*line)[*start..*end];
        let x = shaped.x_for_index(to_display(text, (range.start - b.line_start(*line) - start).min(text.len())));
        let top = p.bounds.top() + p.line_height * row as f32 - self.scroll.y;
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
        let search = if self.preview { None } else { self.render_search(cx) };
        let completion = self.render_completion(cx);
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
            .on_action(cx.listener(|e, _: &MoveUp, _, cx| {
                if let Some(c) = e.completion.as_mut() {
                    c.selected = c.selected.checked_sub(1).unwrap_or(c.items.len() - 1);
                    return cx.notify();
                }
                e.move_vertical(-1, false, cx)
            }))
            .on_action(cx.listener(|e, _: &MoveDown, _, cx| {
                if let Some(c) = e.completion.as_mut() {
                    c.selected = (c.selected + 1) % c.items.len();
                    return cx.notify();
                }
                e.move_vertical(1, false, cx)
            }))
            .on_action(cx.listener(|e, _: &SelectLeft, _, cx| e.motion(cx, |b| b.left(true, false))))
            .on_action(cx.listener(|e, _: &SelectRight, _, cx| e.motion(cx, |b| b.right(true, false))))
            .on_action(cx.listener(|e, _: &SelectUp, _, cx| e.move_vertical(-1, true, cx)))
            .on_action(cx.listener(|e, _: &SelectDown, _, cx| e.move_vertical(1, true, cx)))
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
                e.move_vertical(-rows, false, cx)
            }))
            .on_action(cx.listener(|e, _: &PageDown, _, cx| {
                let rows = e.page_rows();
                e.move_vertical(rows, false, cx)
            }))
            .on_action(cx.listener(|e, _: &SelectPageUp, _, cx| {
                let rows = e.page_rows();
                e.move_vertical(-rows, true, cx)
            }))
            .on_action(cx.listener(|e, _: &SelectPageDown, _, cx| {
                let rows = e.page_rows();
                e.move_vertical(rows, true, cx)
            }))
            .on_action(cx.listener(|e, _: &Backspace, _, cx| {
                e.edit(cx, |b| b.backspace(false, false));
                if e.completion.is_none() && matches!(&e.body, Body::Text(b) if b.extra.is_empty()) {
                    e.update_completion();
                }
            }))
            .on_action(cx.listener(|e, _: &DeleteWordBack, _, cx| e.edit(cx, |b| b.backspace(true, false))))
            .on_action(cx.listener(|e, _: &DeleteToLineStart, _, cx| e.edit(cx, |b| b.backspace(false, true))))
            .on_action(cx.listener(|e, _: &DeleteForward, _, cx| e.edit(cx, |b| b.delete_forward(false))))
            .on_action(cx.listener(|e, _: &DeleteWordForward, _, cx| e.edit(cx, |b| b.delete_forward(true))))
            .on_action(cx.listener(|e, _: &Newline, _, cx| {
                if !e.accept_completion(cx) {
                    e.edit(cx, |b| b.newline())
                }
            }))
            .on_action(cx.listener(|e, _: &Indent, _, cx| {
                if !e.accept_completion(cx) {
                    e.edit(cx, |b| b.indent())
                }
            }))
            .on_action(cx.listener(|e, _: &Outdent, _, cx| e.edit(cx, |b| b.outdent())))
            .on_action(cx.listener(|e, _: &SelectAll, _, cx| e.motion(cx, |b| b.select_all())))
            .on_action(cx.listener(|e, _: &Copy, _, cx| {
                if let Body::Text(b) = &e.body
                    && let Some(text) = selections_text(b)
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }))
            .on_action(cx.listener(|e, _: &Cut, _, cx| {
                if let Some(b) = e.buffer()
                    && let Some(text) = selections_text(b)
                {
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
            .on_action(cx.listener(|e, _: &AddNextOccurrence, _, cx| e.whole(cx, |b| b.add_next_occurrence())))
            .on_action(cx.listener(|e, _: &SelectAllOccurrences, _, cx| e.whole(cx, |b| b.select_all_occurrences())))
            .on_action(cx.listener(|e, _: &AddCursorUp, _, cx| e.whole(cx, |b| b.add_cursor_vertical(-1))))
            .on_action(cx.listener(|e, _: &AddCursorDown, _, cx| e.whole(cx, |b| b.add_cursor_vertical(1))))
            .on_action(cx.listener(|e, _: &CancelEditor, window, cx| {
                if e.completion.take().is_some() {
                    return cx.notify();
                }
                if e.search.is_some() {
                    return e.close_search(window, cx);
                }
                if let Body::Text(b) = &mut e.body
                    && b.clear_extra()
                {
                    return cx.notify();
                }
                cx.propagate();
            }))
            .on_action(cx.listener(|e, _: &ToggleWrap, _, cx| {
                let on = !e.wrap;
                e.set_wrap(on, cx);
            }))
            .on_action(cx.listener(|e, _: &Find, window, cx| e.open_search(false, window, cx)))
            .on_action(cx.listener(|e, _: &FindReplace, window, cx| e.open_search(true, window, cx)))
            .on_action(cx.listener(|e, _: &FindNext, _, cx| e.step_search(1, false, cx)))
            .on_action(cx.listener(|e, _: &FindPrevious, _, cx| e.step_search(-1, false, cx)))
            .on_action(cx.listener(|e, _: &TogglePreview, _, cx| {
                if is_markdown(&e.path) {
                    let on = !e.preview;
                    e.set_preview(on, cx);
                }
            }))
            .child(header)
            .children(banner)
            .children(search)
            .child(body)
            .children(completion)
    }
}

struct EditorElement {
    editor: Entity<FileEditor>,
}

pub struct EditorPrepaint {
    text_bounds: Bounds<Pixels>,
    line_height: Pixels,
    gutter: Vec<(Pixels, ShapedLine)>,
    rows: Vec<(Pixels, ShapedLine)>,
    under: Vec<gpui::PaintQuad>,
    cursors: Vec<gpui::PaintQuad>,
    current_rows: Vec<gpui::PaintQuad>,
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
            Some(Tok::Tag) | Some(Tok::Heading) => hsla(theme.palette[4], 1.0),
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
        let empty = EditorPrepaint { text_bounds: bounds, line_height, gutter: Vec::new(), rows: Vec::new(), under: Vec::new(), cursors: Vec::new(), current_rows: Vec::new() };

        let editor = self.editor.clone();
        let lang = syntax::lang_for(&editor.read(cx).path);
        let char_w = shape(window, "0".into(), vec![run(1, hsla(theme.foreground, 1.0), false)]).width;
        let line_count = match &editor.read(cx).body {
            Body::Text(b) => b.line_count(),
            _ => return empty,
        };
        let digits = line_count.to_string().len().max(3);
        let gutter_w = char_w * digits as f32 + px(24.0);
        let text_left = bounds.left() + gutter_w;
        let text_bounds = Bounds::from_corners(point(text_left, bounds.top()), bounds.bottom_right());
        let text_width = text_bounds.size.width - px(8.0);
        // 複数行の注釈の状態と、折り返しの見た目の行は、書き換えたとき（と幅が変わったとき）だけ作り直す
        let cols = ((text_width / char_w).floor() as usize).max(8);
        editor.update(cx, |e, cx| {
            e.refresh_search(cx);
            let Body::Text(b) = &e.body else { return };
            if let Some(lang) = lang
                && e.states_cache.as_ref().is_none_or(|(v, _)| *v != b.version)
            {
                e.states_cache = Some((b.version, syntax::block_states((0..b.line_count()).map(|l| b.line(l)), lang)));
            }
            if e.wrap {
                if e.rows_cache.as_ref().is_none_or(|(v, c, _)| *v != b.version || *c != cols) {
                    e.rows_cache = Some((b.version, cols, crate::rows::RowMap::build((0..b.line_count()).map(|l| b.line(l)), cols)));
                }
            } else {
                e.rows_cache = None;
            }
        });
        let e = editor.read(cx);
        let Body::Text(b) = &e.body else { return empty };
        let row_count = e.row_count();
        let visible_rows = (bounds.size.height / line_height).ceil() as usize + 1;

        // 縦の送り。カーソルを見せるときは、主のカーソルの行が見える所まで送る
        let cursor = b.cursor();
        let cursor_row = e.row_of(cursor);
        let mut scroll = e.scroll;
        if e.reveal {
            let top = line_height * cursor_row as f32;
            if top < scroll.y {
                scroll.y = top;
            } else if top + line_height > scroll.y + bounds.size.height {
                scroll.y = top + line_height - bounds.size.height;
            }
        }
        let max_y = (line_height * row_count as f32 - line_height * 3.0).max(px(0.0));
        scroll.y = scroll.y.clamp(px(0.0), max_y);
        let first = (scroll.y / line_height).floor() as usize;
        let last = (first + visible_rows).min(row_count);
        let states = e.states_cache.as_ref().map(|(_, s)| s.clone());
        let matches: Vec<Range<usize>> = e.search.as_ref().map(|s| s.matches.clone()).unwrap_or_default();
        let current_match = e.search.as_ref().and_then(|s| s.current.and_then(|i| s.matches.get(i).cloned()));

        let muted = hsla(chrome.text_muted, 0.7);
        let bright = hsla(chrome.text, 1.0);
        let mut gutter = Vec::new();
        let mut shaped_rows: Vec<(usize, usize, usize, Pixels, ShapedLine)> = Vec::new();
        let cursor_lines: Vec<usize> = std::iter::once(b.line_of(cursor)).chain(b.extra.iter().map(|c| b.line_of(c.head()))).collect();
        let mut line_colors: Option<(usize, Vec<Option<Tok>>)> = None;
        for row in first..last {
            let Some((line, start, end)) = e.row(row) else { break };
            let text = b.line(line);
            let y = bounds.top() + line_height * row as f32 - scroll.y;
            // 行番号は、元の行の最初の見た目の行にだけ出す
            if start == 0 {
                let number = (line + 1).to_string();
                let label = format!("{}{}", " ".repeat(digits - number.len()), number);
                let len = label.len();
                gutter.push((y, shape(window, label, vec![run(len, if cursor_lines.contains(&line) { bright } else { muted }, false)])));
            }
            if line_colors.as_ref().is_none_or(|(l, _)| *l != line) {
                let mut colors: Vec<Option<Tok>> = vec![None; text.len()];
                if let Some(lang) = lang {
                    let mut inside = states.as_ref().and_then(|s| s.get(line).copied()).unwrap_or(false);
                    for (range, tok) in syntax::highlight_line(text, lang, &mut inside) {
                        for c in &mut colors[range.start.min(text.len())..range.end.min(text.len())] {
                            *c = Some(tok);
                        }
                    }
                }
                line_colors = Some((line, colors));
            }
            let colors = &line_colors.as_ref().expect("作った").1;
            let line_start = b.line_start(line);
            let marked = e.marked.clone().filter(|m| m.start < line_start + end && m.end > line_start + start);
            let part = &text[start..end];
            let mut runs: Vec<TextRun> = Vec::new();
            let mut last_key: Option<(Option<Tok>, bool)> = None;
            for (i, c) in part.char_indices() {
                let at = start + i;
                let w = if c == '\t' { TAB_WIDTH } else { c.len_utf8() };
                let key = (colors[at], marked.as_ref().is_some_and(|m| m.contains(&(line_start + at))));
                if last_key == Some(key)
                    && let Some(r) = runs.last_mut()
                {
                    r.len += w;
                } else {
                    runs.push(run(w, color_of(key.0), key.1));
                    last_key = Some(key);
                }
            }
            shaped_rows.push((line, start, end, y, shape(window, display_line(part), runs)));
        }

        // 横の送り（折り返していないときだけ）。カーソルを見せるときは、その桁が見える所まで送る
        let x_in_row = |offset: usize| -> Option<(Pixels, Pixels)> {
            let line = b.line_of(offset);
            let in_line = offset - b.line_start(line);
            let row = e.row_of(offset);
            let (l, start, end, y, shaped) = shaped_rows.get(row.checked_sub(first)?)?;
            debug_assert_eq!(*l, line);
            let part = &b.line(line)[*start..*end];
            Some((shaped.x_for_index(to_display(part, in_line.saturating_sub(*start).min(part.len()))), *y))
        };
        if e.wrap {
            scroll.x = px(0.0);
        } else if e.reveal
            && let Some((x, _)) = x_in_row(cursor)
        {
            if x < scroll.x {
                scroll.x = (x - char_w * 4.0).max(px(0.0));
            } else if x > scroll.x + text_width {
                scroll.x = x - text_width + char_w * 4.0;
            }
        } else {
            let widest = shaped_rows.iter().map(|r| r.4.width).fold(px(0.0), |a, b| a.max(b));
            scroll.x = scroll.x.min((widest - text_width + char_w * 4.0).max(px(0.0)));
        }

        // 範囲を見た目の行ごとの四角にする（選択・検索の一致）
        let range_quads = |range: &Range<usize>, color: gpui::Hsla, out: &mut Vec<gpui::PaintQuad>| {
            for (line, start, end, y, shaped) in &shaped_rows {
                let row_start = b.line_start(*line) + start;
                let row_end = b.line_start(*line) + end;
                let last_row_of_line = *end == b.line(*line).len();
                if range.end < row_start || range.start > row_end || (range.start == row_end && !range.is_empty() && !last_row_of_line) {
                    continue;
                }
                let part = &b.line(*line)[*start..*end];
                let from = if range.start > row_start { shaped.x_for_index(to_display(part, range.start - row_start)) } else { px(0.0) };
                let to = if range.end <= row_end { shaped.x_for_index(to_display(part, range.end - row_start)) } else { shaped.width + char_w };
                if to > from {
                    out.push(fill(Bounds::from_corners(point(text_left + from - scroll.x, *y), point(text_left + to - scroll.x, *y + line_height)), color));
                }
            }
        };
        let mut under = Vec::new();
        let match_color = hsla(theme.palette[3], 0.25);
        let current_color = hsla(theme.palette[3], 0.55);
        let view_start = shaped_rows.first().map(|r| b.line_start(r.0) + r.1).unwrap_or(0);
        let view_end = shaped_rows.last().map(|r| b.line_start(r.0) + r.2).unwrap_or(0);
        for m in matches.iter().filter(|m| m.end >= view_start && m.start <= view_end) {
            range_quads(m, if Some(m) == current_match.as_ref() { current_color } else { match_color }, &mut under);
        }
        let selection_color = hsla(chrome.selection, 1.0);
        let mut cursors = Vec::new();
        let mut current_rows = Vec::new();
        let mut cursor_at = None;
        let all: Vec<(Range<usize>, usize, bool)> = b
            .extra
            .iter()
            .map(|c| (c.range.clone(), c.head(), false))
            .chain(std::iter::once((b.selected.clone(), cursor, true)))
            .collect();
        for (range, head, primary) in &all {
            if !range.is_empty() {
                range_quads(range, selection_color, &mut under);
            }
            if let Some((x, y)) = x_in_row(*head) {
                cursors.push(fill(Bounds::new(point(text_left + x - scroll.x, y), size(px(2.0), line_height)), hsla(chrome.accent, 1.0)));
                if range.is_empty() {
                    current_rows.push(fill(Bounds::new(point(bounds.left(), y), size(bounds.size.width, line_height)), hsla(chrome.bg_hover, 0.5)));
                }
                if *primary {
                    cursor_at = Some(point(text_left + x - scroll.x, y + line_height));
                }
            }
        }
        let rows_for_hit: Vec<(usize, usize, usize, ShapedLine)> = shaped_rows.iter().map(|(l, s, e, _, sh)| (*l, *s, *e, sh.clone())).collect();
        editor.update(cx, |e, _| {
            e.scroll = scroll;
            e.reveal = false;
            e.painted = Some(Painted { bounds, text_left, line_height, first_row: first, rows: rows_for_hit, cursor_at });
        });
        let rows = shaped_rows.into_iter().map(|(_, _, _, y, s)| (y, s)).collect();
        EditorPrepaint { text_bounds, line_height, gutter, rows, under, cursors, current_rows }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), prepaint: &mut EditorPrepaint, window: &mut Window, cx: &mut App) {
        let focus = self.editor.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);
        let line_height = prepaint.line_height;
        let scroll_x = self.editor.read(cx).scroll.x;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for q in prepaint.current_rows.drain(..) {
                window.paint_quad(q);
            }
            for (y, label) in &prepaint.gutter {
                let _ = label.paint(point(bounds.left() + px(8.0), *y), line_height, gpui::TextAlign::Left, None, window, cx);
            }
        });
        let text_bounds = prepaint.text_bounds;
        window.with_content_mask(Some(ContentMask { bounds: text_bounds }), |window| {
            for q in prepaint.under.drain(..) {
                window.paint_quad(q);
            }
            for (y, row) in &prepaint.rows {
                let _ = row.paint(point(text_bounds.left() - scroll_x, *y), line_height, gpui::TextAlign::Left, None, window, cx);
            }
            if focus.is_focused(window) {
                for q in prepaint.cursors.drain(..) {
                    window.paint_quad(q);
                }
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
