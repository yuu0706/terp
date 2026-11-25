// 1行の文字の入力欄。検索欄・名前の変更・設定の画面で使う。入力方式（IME）にも対応する。
use crate::appearance::{Appearance, hsla};
use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, ElementId, ElementInputHandler, Entity, EntityInputHandler,
    EventEmitter, FocusHandle, Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ShapedLine, SharedString, Style, TextRun, UTF16Selection,
    UnderlineStyle, Window, actions, div, fill, point, prelude::*, px, relative, size,
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

actions!(
    text_input,
    [
        Backspace,
        Delete,
        DeleteToStart,
        DeleteWord,
        Left,
        Right,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        Submit,
        SubmitShift,
        SubmitCommand,
        Cancel,
        Up,
        Down,
        TabNext,
        TabPrev,
    ]
);

pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some("TextInput");
    vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("cmd-backspace", DeleteToStart, c),
        KeyBinding::new("alt-backspace", DeleteWord, c),
        KeyBinding::new("ctrl-w", DeleteWord, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("alt-left", WordLeft, c),
        KeyBinding::new("alt-right", WordRight, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("cmd-a", SelectAll, c),
        KeyBinding::new("cmd-left", Home, c),
        KeyBinding::new("ctrl-a", Home, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("cmd-right", End, c),
        KeyBinding::new("ctrl-e", End, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("cmd-v", Paste, c),
        KeyBinding::new("cmd-c", Copy, c),
        KeyBinding::new("cmd-x", Cut, c),
        KeyBinding::new("enter", Submit, c),
        KeyBinding::new("shift-enter", SubmitShift, c),
        KeyBinding::new("cmd-enter", SubmitCommand, c),
        KeyBinding::new("escape", Cancel, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("tab", TabNext, c),
        KeyBinding::new("shift-tab", TabPrev, c),
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputEvent {
    Changed,
    Submit { shift: bool },
    Cancel,
    Up,
    Down,
    Tab { back: bool },
    // 端で ←→ を押した（字の中を動けないとき）
    EdgeLeft,
    EdgeRight,
}

pub struct TextInput {
    focus: FocusHandle,
    content: String,
    placeholder: SharedString,
    selected: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    // 行ごとの始まりの位置と字形
    last_layout: Vec<(usize, ShapedLine)>,
    last_bounds: Option<Bounds<Pixels>>,
    last_line_height: Pixels,
    // 複数行（コミットメッセージなど）。Enter で改行し、⌘Enter で確定する
    multiline: bool,
    min_rows: usize,
    selecting: bool,
}

impl EventEmitter<InputEvent> for TextInput {}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextInput {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        TextInput {
            focus,
            content: String::new(),
            placeholder: placeholder.into(),
            selected: 0..0,
            reversed: false,
            marked: None,
            last_layout: Vec::new(),
            last_bounds: None,
            last_line_height: px(18.0),
            multiline: false,
            min_rows: 1,
            selecting: false,
        }
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn set_multiline(&mut self, rows: usize) {
        self.multiline = true;
        self.min_rows = rows.max(1);
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.content = if self.multiline { text.replace("\r\n", "\n") } else { text.replace(['\n', '\r'], " ") };
        self.selected = self.content.len()..self.content.len();
        self.marked = None;
        cx.notify();
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.selected = 0..self.content.len();
        self.reversed = false;
        cx.notify();
    }

    pub fn set_placeholder(&mut self, text: impl Into<SharedString>) {
        self.placeholder = text.into();
    }

    pub fn is_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.reversed { self.selected.start } else { self.selected.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected = offset..offset;
        self.reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).rev().find_map(|(i, _)| (i < offset).then_some(i)).unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).find_map(|(i, _)| (i > offset).then_some(i)).unwrap_or(self.content.len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        self.content.unicode_word_indices().rev().find_map(|(i, _)| (i < offset).then_some(i)).unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        self.content
            .unicode_word_indices()
            .find_map(|(i, w)| (i + w.len() > offset).then_some(i + w.len()))
            .unwrap_or(self.content.len())
    }

    fn replace(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        let text = if self.multiline { text.replace("\r\n", "\n").replace('\r', "\n") } else { text.replace(['\n', '\r'], " ") };
        self.content = format!("{}{}{}", &self.content[..range.start], text, &self.content[range.end..]);
        let end = range.start + text.len();
        self.selected = end..end;
        self.reversed = false;
        self.marked = None;
        self.changed(cx);
    }

    fn delete_selection_or(&mut self, target: usize, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            let at = self.cursor();
            let range = if target < at { target..at } else { at..target };
            if range.is_empty() {
                return;
            }
            self.replace(range, "", cx);
        } else {
            self.replace(self.selected.clone(), "", cx);
        }
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.selecting = true;
        let index = self.index_for_position(event.position);
        if event.click_count >= 2 {
            self.selected = 0..self.content.len();
            cx.notify();
        } else if event.modifiers.shift {
            self.select_to(index, cx);
        } else {
            self.move_to(index, cx);
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && event.pressed_button == Some(MouseButton::Left) {
            self.select_to(self.index_for_position(event.position), cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn index_for_position(&self, position: Point<Pixels>) -> usize {
        let Some(bounds) = self.last_bounds.as_ref() else { return 0 };
        if self.content.is_empty() || self.last_layout.is_empty() {
            return 0;
        }
        let row = (((position.y - bounds.top()) / self.last_line_height).floor().max(0.0) as usize).min(self.last_layout.len() - 1);
        let (start, line) = &self.last_layout[row];
        (start + line.closest_index_for_x(position.x - bounds.left())).min(self.content.len())
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for c in self.content.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += c.len_utf16();
            utf8 += c.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        self.content[..offset.min(self.content.len())].encode_utf16().count()
    }

    fn range_to_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(r.start)..self.offset_to_utf16(r.end)
    }

    fn range_from_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(r.start)..self.offset_from_utf16(r.end)
    }

}

impl EntityInputHandler for TextInput {
    fn text_for_range(&mut self, range: Range<usize>, actual: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let range = self.range_from_utf16(&range);
        actual.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected), reversed: self.reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone()).unwrap_or(self.selected.clone());
        self.replace(range, text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        new_selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone()).unwrap_or(self.selected.clone());
        self.content = format!("{}{}{}", &self.content[..range.start], text, &self.content[range.end..]);
        self.marked = (!text.is_empty()).then(|| range.start..range.start + text.len());
        let start16 = self.offset_to_utf16(range.start);
        let len16 = text.encode_utf16().count();
        self.selected = new_selected
            .map(|s| self.range_from_utf16(&(start16 + s.start.min(len16)..start16 + s.end.min(len16))))
            .unwrap_or_else(|| range.start + text.len()..range.start + text.len());
        self.reversed = false;
        cx.notify();
    }

    fn bounds_for_range(&mut self, range: Range<usize>, bounds: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range);
        let row = self.last_layout.iter().rposition(|(s, _)| *s <= range.start)?;
        let (start, layout) = &self.last_layout[row];
        let top = bounds.top() + self.last_line_height * row as f32;
        let end = range.end.min(start + layout.len);
        Some(Bounds::from_corners(
            point(bounds.left() + layout.x_for_index(range.start - start), top),
            point(bounds.left() + layout.x_for_index(end.saturating_sub(*start)), top + self.last_line_height),
        ))
    }

    fn character_index_for_point(&mut self, p: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        self.last_bounds?.localize(&p)?;
        Some(self.offset_to_utf16(self.index_for_position(p)))
    }
}

impl Render for TextInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("text-input")
            .key_context("TextInput")
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .w_full()
            .overflow_hidden()
            .on_action(cx.listener(|this, _: &Backspace, _, cx| {
                let target = this.previous_boundary(this.cursor());
                this.delete_selection_or(target, cx)
            }))
            .on_action(cx.listener(|this, _: &Delete, _, cx| {
                let target = this.next_boundary(this.cursor());
                this.delete_selection_or(target, cx)
            }))
            .on_action(cx.listener(|this, _: &DeleteToStart, _, cx| this.delete_selection_or(0, cx)))
            .on_action(cx.listener(|this, _: &DeleteWord, _, cx| {
                let target = this.previous_word(this.cursor());
                this.delete_selection_or(target, cx)
            }))
            .on_action(cx.listener(|this, _: &Left, _, cx| {
                if this.selected.is_empty() && this.cursor() == 0 {
                    cx.emit(InputEvent::EdgeLeft);
                    return;
                }
                let to = if this.selected.is_empty() { this.previous_boundary(this.cursor()) } else { this.selected.start };
                this.move_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &Right, _, cx| {
                if this.selected.is_empty() && this.cursor() == this.content.len() {
                    cx.emit(InputEvent::EdgeRight);
                    return;
                }
                let to = if this.selected.is_empty() { this.next_boundary(this.cursor()) } else { this.selected.end };
                this.move_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &WordLeft, _, cx| {
                let to = this.previous_word(this.cursor());
                this.move_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &WordRight, _, cx| {
                let to = this.next_word(this.cursor());
                this.move_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &SelectLeft, _, cx| {
                let to = this.previous_boundary(this.cursor());
                this.select_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &SelectRight, _, cx| {
                let to = this.next_boundary(this.cursor());
                this.select_to(to, cx)
            }))
            .on_action(cx.listener(|this, _: &SelectAll, _, cx| this.select_all_text(cx)))
            .on_action(cx.listener(|this, _: &Home, _, cx| this.move_to(0, cx)))
            .on_action(cx.listener(|this, _: &End, _, cx| {
                let end = this.content.len();
                this.move_to(end, cx)
            }))
            .on_action(cx.listener(|this, _: &Paste, _, cx| {
                if let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) {
                    this.replace(this.selected.clone(), &text, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &Copy, _, cx| {
                if !this.selected.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(this.content[this.selected.clone()].to_string()));
                }
            }))
            .on_action(cx.listener(|this, _: &Cut, _, cx| {
                if !this.selected.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(this.content[this.selected.clone()].to_string()));
                    this.replace(this.selected.clone(), "", cx);
                }
            }))
            .on_action(cx.listener(|this, _: &Submit, _, cx| {
                if this.multiline {
                    this.replace(this.selected.clone(), "\n", cx);
                } else {
                    cx.emit(InputEvent::Submit { shift: false })
                }
            }))
            .on_action(cx.listener(|_, _: &SubmitCommand, _, cx| cx.emit(InputEvent::Submit { shift: false })))
            .on_action(cx.listener(|_, _: &SubmitShift, _, cx| cx.emit(InputEvent::Submit { shift: true })))
            .on_action(cx.listener(|_, _: &Cancel, _, cx| cx.emit(InputEvent::Cancel)))
            .on_action(cx.listener(|_, _: &Up, _, cx| cx.emit(InputEvent::Up)))
            .on_action(cx.listener(|_, _: &Down, _, cx| cx.emit(InputEvent::Down)))
            .on_action(cx.listener(|_, _: &TabNext, _, cx| cx.emit(InputEvent::Tab { back: false })))
            .on_action(cx.listener(|_, _: &TabPrev, _, cx| cx.emit(InputEvent::Tab { back: true })))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .child(TextElement { input: cx.entity() })
    }
}

struct TextElement {
    input: Entity<TextInput>,
}

pub struct TextPrepaint {
    lines: Vec<(usize, ShapedLine)>,
    cursor: Option<PaintQuad>,
    selection: Vec<PaintQuad>,
}

impl gpui::Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = TextPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let input = self.input.read(cx);
        let rows = if input.multiline { input.content.split('\n').count().max(input.min_rows) } else { 1 };
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = (window.line_height() * rows as f32).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> TextPrepaint {
        let chrome = cx.global::<Appearance>().chrome.clone();
        let input = self.input.read(cx);
        let style = window.text_style();
        let empty = input.content.is_empty();
        let color = if empty { hsla(chrome.text_muted, 1.0) } else { style.color };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = window.line_height();
        let source: String = if empty { input.placeholder.to_string() } else { input.content.clone() };
        let mut lines = Vec::new();
        let mut offset = 0;
        for text in source.split('\n') {
            let start = offset;
            offset += text.len() + 1;
            let mut runs = Vec::new();
            let base = TextRun { len: 0, font: style.font(), color, background_color: None, underline: None, strikethrough: None };
            // 変換中の文字は下線を引く
            match input.marked.as_ref().filter(|_| !empty) {
                Some(m) if m.start < start + text.len() && m.end > start => {
                    let a = m.start.max(start) - start;
                    let b = m.end.min(start + text.len()) - start;
                    runs.push(TextRun { len: a, ..base.clone() });
                    runs.push(TextRun { len: b - a, underline: Some(UnderlineStyle { color: Some(color), thickness: px(1.0), wavy: false }), ..base.clone() });
                    runs.push(TextRun { len: text.len() - b, ..base.clone() });
                }
                _ => runs.push(TextRun { len: text.len(), ..base.clone() }),
            }
            let runs: Vec<TextRun> = runs.into_iter().filter(|r| r.len > 0).collect();
            let shaped = window.text_system().shape_line(SharedString::from(text.to_string()), font_size, &runs, None);
            lines.push((start, shaped));
        }
        let locate = |i: usize| -> (usize, Pixels) {
            if empty {
                return (0, px(0.0));
            }
            let row = lines.iter().rposition(|(s, _)| *s <= i).unwrap_or(0);
            let (s, l) = &lines[row];
            (row, l.x_for_index(i - s))
        };
        let mut selection = Vec::new();
        let mut cursor = None;
        if input.selected.is_empty() {
            let (row, x) = locate(input.cursor());
            cursor = Some(fill(
                Bounds::new(point(bounds.left() + x, bounds.top() + line_height * row as f32), size(px(1.5), line_height)),
                hsla(chrome.accent, 1.0),
            ));
        } else {
            let (r1, x1) = locate(input.selected.start);
            let (r2, x2) = locate(input.selected.end);
            for row in r1..=r2 {
                let from = if row == r1 { x1 } else { px(0.0) };
                let to = if row == r2 { x2 } else { lines[row].1.width.max(px(4.0)) };
                let top = bounds.top() + line_height * row as f32;
                selection.push(fill(Bounds::from_corners(point(bounds.left() + from, top), point(bounds.left() + to, top + line_height)), hsla(chrome.selection, 1.0)));
            }
        }
        TextPrepaint { lines, cursor, selection }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut TextPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.input.clone()), cx);
        for quad in prepaint.selection.drain(..) {
            window.paint_quad(quad);
        }
        let line_height = window.line_height();
        let lines = std::mem::take(&mut prepaint.lines);
        for (row, (_, line)) in lines.iter().enumerate() {
            let _ = line.paint(point(bounds.left(), bounds.top() + line_height * row as f32), line_height, gpui::TextAlign::Left, None, window, cx);
        }
        if focus.is_focused(window)
            && let Some(cursor) = prepaint.cursor.take()
        {
            window.paint_quad(cursor);
        }
        let empty = self.input.read(cx).content.is_empty();
        self.input.update(cx, |input, _| {
            input.last_layout = if empty { Vec::new() } else { lines };
            input.last_bounds = Some(bounds);
            input.last_line_height = line_height;
        });
    }
}


#[cfg(test)]
mod tests {
    #[test]
    fn 単語の境目() {
        use unicode_segmentation::UnicodeSegmentation;
        let words: Vec<_> = "git log --all".unicode_word_indices().map(|(i, _)| i).collect();
        assert_eq!(words, vec![0, 4, 10]);
    }
}
