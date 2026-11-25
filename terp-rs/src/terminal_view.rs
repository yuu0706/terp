// ターミナルの画面。文字の格子を描き、キー・マウス・入力方式（IME）の入力をシェルへ渡す。
use crate::agent::{self, AgentEvent, AgentState, AgentStatus};
use crate::appearance::{Appearance, hsla};
use crate::config::{Rgb, Theme, ensure_contrast};
use crate::input::{InputEvent, TextInput};
use crate::keys::{self, Mods};
use crate::search;
use crate::terminal::{GridSize, ProcessInfo, TermEvent, Terminal};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as AlacPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::search::Match;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    App, Bounds, ClipboardItem, Context, Element, ElementId, ElementInputHandler, Entity, EntityInputHandler,
    EventEmitter, FocusHandle, Subscription, Focusable, FontStyle, FontWeight, GlobalElementId, InspectorElementId,
    IntoElement, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad,
    Pixels, Point, Render, ScrollDelta, ScrollEvent, ShapedLine, SharedString, Style, Task, TextAlign, TextRun,
    UTF16Selection, UnderlineStyle, StrikethroughStyle, Window, actions, div, fill, outline, point, prelude::*, px,
    relative, size,
};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::Instant;

actions!(terminal, [Copy, Paste, SelectAll, Clear, Find, FindNext, FindPrev]);

struct Search {
    input: Entity<TextInput>,
    matches: Vec<Match>,
    index: Option<usize>,
    refreshed: Instant,
    _subscription: Subscription,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Attention {
    Done,
    Bell,
}

pub enum TerminalEvent {
    Changed,
    Exited,
    // 応答の終わり・許可待ち・ベル。通知を出すかは親が決める
    Attention { kind: Attention, message: String },
}

#[derive(Clone, Copy, Default)]
struct Layout {
    origin: Point<Pixels>,
    cell_width: Pixels,
    line_height: Pixels,
    cols: usize,
    rows: usize,
}

pub struct TerminalView {
    pub terminal: Terminal,
    focus: FocusHandle,
    pub title: Option<String>,
    pub process: Option<ProcessInfo>,
    pub start_cwd: PathBuf,
    pub unseen_bell: bool,
    pub agent: AgentStatus,
    pub agent_title: Option<String>,
    // ダブルクリックで付けた名前
    pub custom_name: Option<String>,
    title_working: bool,
    marked_text: Option<String>,
    layout: Layout,
    selecting: bool,
    scroll_remainder: f32,
    replaying: bool,
    search: Option<Search>,
    _events: Task<()>,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TerminalView {
    // シェルは呼び出し側で先に起動し（またはつなぎ直し）、起動できたときだけ画面を作る
    pub fn new(terminal: Terminal, events: UnboundedReceiver<TermEvent>, cwd: &Path, cx: &mut App) -> Entity<Self> {
        let cwd = cwd.to_path_buf();
        cx.new(|cx| {
            let task = cx.spawn(async move |this, cx| Self::pump(this, events, cx).await);
            TerminalView {
                terminal,
                focus: cx.focus_handle(),
                title: None,
                process: None,
                start_cwd: cwd,
                unseen_bell: false,
                agent: AgentStatus::default(),
                agent_title: None,
                custom_name: None,
                title_working: false,
                marked_text: None,
                layout: Layout::default(),
                selecting: false,
                scroll_remainder: 0.0,
                replaying: false,
                search: None,
                _events: task,
            }
        })
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }

    async fn pump(this: gpui::WeakEntity<Self>, mut events: UnboundedReceiver<TermEvent>, cx: &mut gpui::AsyncApp) {
        while let Some(event) = events.next().await {
            let alive = this.update(cx, |view, cx| view.handle_event(event, cx)).is_ok();
            if !alive {
                break;
            }
        }
    }

    fn handle_event(&mut self, event: TermEvent, cx: &mut Context<Self>) {
        match event {
            TermEvent::Wakeup => {
                self.terminal.clear_wakeup();
                if self.is_agent() && !self.replaying {
                    self.agent.apply(AgentEvent::Output, Instant::now());
                }
                // 出力で行がずれるため、探している間は当たりを数え直す（間を空けて）
                if self.search.as_ref().is_some_and(|s| s.refreshed.elapsed().as_millis() >= 300) {
                    self.refresh_matches(false, cx);
                }
                cx.notify();
            }
            TermEvent::Title(title) => {
                let parsed = agent::parse_title(&title);
                if parsed.text.is_some() {
                    self.agent_title = parsed.text;
                }
                self.title = Some(title).filter(|t| !t.trim().is_empty());
                // 作業中から入力待ちに変わったら、応答が終わったことを知らせる
                let finished = self.title_working && !parsed.working;
                self.title_working = parsed.working;
                self.agent.apply(AgentEvent::Title { working: parsed.working }, Instant::now());
                if finished && !self.replaying {
                    cx.emit(TerminalEvent::Attention { kind: Attention::Done, message: String::new() });
                }
                cx.emit(TerminalEvent::Changed);
            }
            TermEvent::ReplayStart => self.replaying = true,
            TermEvent::ReplayEnd => {
                self.replaying = false;
                // 流し直しで崩れた画面を、プログラムに描き直させる
                self.terminal.redraw();
                cx.notify();
            }
            TermEvent::Notify(message) => {
                cx.emit(TerminalEvent::Attention { kind: Attention::Done, message });
            }
            TermEvent::ResetTitle => {
                self.title = None;
                cx.emit(TerminalEvent::Changed);
            }
            TermEvent::Bell if self.replaying => {}
            TermEvent::Bell => {
                self.unseen_bell = true;
                cx.emit(TerminalEvent::Attention { kind: Attention::Bell, message: String::new() });
            }
            TermEvent::Clipboard(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            TermEvent::Exit => cx.emit(TerminalEvent::Exited),
        }
    }

    pub fn refresh_process(&mut self, cx: &mut Context<Self>) {
        let process = self.terminal.foreground();
        if process != self.process {
            let before = self.process.as_ref().map(|p| p.name.clone());
            let after = process.as_ref().map(|p| p.name.clone());
            // 別のプログラムに替わったら、前のエージェントの状態を捨てる
            if before != after && agent::is_agent(before.as_deref()) {
                self.agent.apply(AgentEvent::Reset, Instant::now());
                self.agent_title = None;
                self.title_working = false;
            }
            self.process = process;
            cx.emit(TerminalEvent::Changed);
        }
    }

    pub fn cwd(&self) -> PathBuf {
        self.process.as_ref().and_then(|p| p.cwd.clone()).unwrap_or_else(|| self.start_cwd.clone())
    }

    pub fn is_agent(&self) -> bool {
        agent::is_agent(self.process.as_ref().map(|p| p.name.as_str()))
    }

    pub fn agent_state(&self) -> AgentState {
        if self.is_agent() { self.agent.state(Instant::now()) } else { AgentState::Idle }
    }

    // 応答の終わり・許可待ちの知らせを状態に写す。seen は利用者が今その端末を見ているか
    pub fn mark_done(&mut self, message: &str, seen: bool, cx: &mut Context<Self>) {
        self.agent.apply(AgentEvent::Notification { message, seen }, Instant::now());
        cx.notify();
    }

    pub fn mark_seen(&mut self) {
        self.agent.apply(AgentEvent::Seen, Instant::now());
        self.unseen_bell = false;
    }

    // 一覧とタブに出す名前。付けた名前 > エージェントなどが出した題名 > 作業場所のフォルダ名の順。
    // 題名は前面がシェルでないときだけ使う（シェルの題名は作業場所の繰り返しで、見分けの役に立たない）
    pub fn display_name(&self) -> String {
        if let Some(name) = self.custom_name.as_ref().filter(|n| !n.trim().is_empty()) {
            return name.clone();
        }
        if self.is_agent() {
            if let Some(title) = &self.agent_title {
                return title.clone();
            }
            if let Some(title) = self.title.as_ref().map(|t| agent::parse_title(t)).and_then(|t| t.text) {
                return title;
            }
        }
        folder_name(&self.cwd())
    }

    // Finder などから落としたパスを、打ったのと同じように送る
    pub fn input_paths(&mut self, paths: &[PathBuf], cx: &mut Context<Self>) {
        let text = terminal_paths(paths);
        if !text.is_empty() {
            self.write_input(text.as_bytes(), cx);
        }
    }

    fn mode(&self) -> TermMode {
        *self.terminal.term.lock().mode()
    }

    fn write_input(&mut self, bytes: &[u8], cx: &mut Context<Self>) {
        self.agent.apply(AgentEvent::Input, Instant::now());
        {
            let mut term = self.terminal.term.lock();
            term.scroll_display(Scroll::Bottom);
            term.selection = None;
        }
        self.terminal.write(bytes);
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // 検索欄など、中の部品に入力があるときはシェルへ送らない
        if !self.focus.is_focused(window) {
            return;
        }
        // 変換中の文字があるときは、確定・取り消しのキーを入力方式に任せる
        if self.marked_text.is_some() {
            return;
        }
        let m = &event.keystroke.modifiers;
        let mods = Mods { ctrl: m.control, alt: m.alt, shift: m.shift, cmd: m.platform };
        let app_cursor = self.mode().contains(TermMode::APP_CURSOR);
        if let Some(bytes) = keys::to_bytes(&event.keystroke.key, mods, app_cursor) {
            self.write_input(&bytes, cx);
            cx.stop_propagation();
        }
    }

    fn copy(&mut self, _: &Copy, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.terminal.term.lock().selection_to_string() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn paste(&mut self, _: &Paste, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else { return };
        let bytes = if self.mode().contains(TermMode::BRACKETED_PASTE) {
            // 貼り付けの終わりの印を中に含めると、残りがコマンドとして動くため取り除く
            format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
        };
        self.write_input(&bytes, cx);
    }

    fn select_all(&mut self, _: &SelectAll, _window: &mut Window, cx: &mut Context<Self>) {
        let mut term = self.terminal.term.lock();
        let top = AlacPoint::new(Line(-(term.history_size() as i32)), Column(0));
        let bottom = AlacPoint::new(Line(term.screen_lines() as i32 - 1), Column(term.columns().saturating_sub(1)));
        let mut selection = Selection::new(SelectionType::Simple, top, Side::Left);
        selection.update(bottom, Side::Right);
        term.selection = Some(selection);
        drop(term);
        cx.notify();
    }

    fn clear(&mut self, _: &Clear, _window: &mut Window, cx: &mut Context<Self>) {
        let alt_screen = {
            let mut term = self.terminal.term.lock();
            term.grid_mut().clear_history();
            term.selection = None;
            term.mode().contains(TermMode::ALT_SCREEN)
        };
        // 全画面のプログラムには ⌃L を送らない（プログラムの操作として受け取られるため）
        if !alt_screen {
            self.terminal.write(b"\x0c");
        }
        cx.notify();
    }

    fn open_search(&mut self, _: &Find, window: &mut Window, cx: &mut Context<Self>) {
        let selected = self.terminal.term.lock().selection_to_string().filter(|t| !t.contains('\n') && !t.is_empty());
        if self.search.is_none() {
            let input = cx.new(|cx| TextInput::new("端末の中を探す", cx));
            let subscription = cx.subscribe_in(&input, window, |view, _, event, window, cx| match event {
                InputEvent::Changed => view.refresh_matches(true, cx),
                InputEvent::Submit { shift } => view.step_search(!shift, cx),
                InputEvent::Cancel => view.close_search(window, cx),
                _ => {}
            });
            self.search = Some(Search { input, matches: Vec::new(), index: None, refreshed: Instant::now(), _subscription: subscription });
        }
        let Some(search) = &self.search else { return };
        let input = search.input.clone();
        input.update(cx, |input, cx| {
            if let Some(text) = &selected {
                input.set_text(text, cx);
            }
            input.select_all_text(cx);
        });
        window.focus(&input.focus_handle(cx), cx);
        self.refresh_matches(true, cx);
    }

    fn find_next(&mut self, _: &FindNext, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.is_none() {
            self.open_search(&Find, window, cx);
        }
        self.step_search(true, cx);
    }

    fn find_prev(&mut self, _: &FindPrev, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.is_none() {
            self.open_search(&Find, window, cx);
        }
        self.step_search(false, cx);
    }

    // 当たりを数え直す。pick なら表示している範囲の最初の当たりを選び直す
    fn refresh_matches(&mut self, pick: bool, cx: &mut Context<Self>) {
        let Some(search) = self.search.as_mut() else { return };
        let query = search.input.read(cx).text().to_string();
        let term = self.terminal.term.lock();
        let previous = search.index.and_then(|i| search.matches.get(i)).map(|m| *m.start());
        search.matches = search::find_all(&term, &query);
        search.refreshed = Instant::now();
        search.index = if pick {
            search::first_visible(&search.matches, Line(-(term.grid().display_offset() as i32)))
        } else {
            previous
                .and_then(|p| search.matches.iter().position(|m| *m.start() >= p))
                .or_else(|| search::first_visible(&search.matches, Line(0)))
        };
        drop(term);
        if pick {
            self.reveal_match();
        }
        cx.notify();
    }

    fn step_search(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(search) = self.search.as_mut() else { return };
        search.index = search::step(search.index, search.matches.len(), forward);
        self.reveal_match();
        cx.notify();
    }

    fn reveal_match(&mut self) {
        let Some(search) = &self.search else { return };
        if let Some(m) = search.index.and_then(|i| search.matches.get(i)) {
            self.terminal.term.lock().scroll_to_point(*m.start());
        }
    }

    fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn render_search(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let search = self.search.as_ref()?;
        let chrome = cx.global::<Appearance>().chrome.clone();
        let query = search.input.read(cx).text().to_string();
        let label = search::count_label(search.index, search.matches.len(), &query);
        let button = |id: &'static str, text: &'static str, tip: &'static str| {
            div()
                .id(id)
                .px_1()
                .rounded_sm()
                .text_color(hsla(chrome.text_muted, 1.0))
                .hover(|s| s.bg(hsla(chrome.bg_hover, 1.0)).text_color(hsla(chrome.text, 1.0)))
                .tooltip(move |_, cx| crate::tooltip::text(tip, cx))
                .child(text)
        };
        Some(
            div()
                .id("term-search")
                .absolute()
                .top(px(6.0))
                .right(px(14.0))
                .w(px(320.0))
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(hsla(chrome.border, 1.0))
                .bg(hsla(chrome.bg, 1.0))
                .text_sm()
                .text_color(hsla(chrome.text, 1.0))
                .shadow_md()
                .cursor_default()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_scroll(|_, _, cx| cx.stop_propagation())
                .child(div().flex_1().min_w_0().child(search.input.clone()))
                .child(div().flex_none().text_xs().text_color(hsla(chrome.text_muted, 1.0)).child(label))
                .child(button("search-prev", "↑", "前へ（⇧Enter）").on_click(cx.listener(|v, _, _, cx| v.step_search(false, cx))))
                .child(button("search-next", "↓", "次へ（Enter・⌘G）").on_click(cx.listener(|v, _, _, cx| v.step_search(true, cx))))
                .child(button("search-close", "×", "閉じる（Esc）").on_click(cx.listener(|v, _, w, cx| v.close_search(w, cx))))
                .into_any_element(),
        )
    }

    fn grid_point(&self, position: Point<Pixels>, display_offset: usize) -> (AlacPoint, Side) {
        let l = self.layout;
        if l.cols == 0 || l.rows == 0 {
            return (AlacPoint::new(Line(0), Column(0)), Side::Left);
        }
        let x = ((position.x - l.origin.x) / l.cell_width).max(0.0);
        let y = ((position.y - l.origin.y) / l.line_height).max(0.0);
        let col = (x.floor() as usize).min(l.cols - 1);
        let row = (y.floor() as usize).min(l.rows - 1);
        let side = if x.fract() > 0.5 { Side::Right } else { Side::Left };
        (AlacPoint::new(Line(row as i32 - display_offset as i32), Column(col)), side)
    }

    fn mouse_report(&self, button: u8, pressed: bool, position: Point<Pixels>, mods: &gpui::Modifiers) -> Option<Vec<u8>> {
        let mode = self.mode();
        if !mode.intersects(TermMode::MOUSE_MODE) {
            return None;
        }
        let (point, _) = self.grid_point(position, 0);
        let (col, row) = (point.column.0 + 1, point.line.0.max(0) as usize + 1);
        let code = button + if mods.shift { 4 } else { 0 } + if mods.alt { 8 } else { 0 } + if mods.control { 16 } else { 0 };
        if mode.contains(TermMode::SGR_MOUSE) {
            return Some(format!("\x1b[<{code};{col};{row}{}", if pressed { 'M' } else { 'm' }).into_bytes());
        }
        if col > 223 || row > 223 {
            return None;
        }
        let code = if pressed { code } else { 3 + (code & !3) };
        Some(vec![0x1b, b'[', b'M', 32 + code, 32 + col as u8, 32 + row as u8])
    }

    fn uses_mouse(&self, mods: &gpui::Modifiers) -> bool {
        // ⇧ を押しているときは、プログラムがマウスを使っていても文字を選べるようにする
        !mods.shift && self.mode().intersects(TermMode::MOUSE_MODE)
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        if self.uses_mouse(&event.modifiers) {
            let button = match event.button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                _ => return,
            };
            if let Some(bytes) = self.mouse_report(button, true, event.position, &event.modifiers) {
                self.terminal.write(&bytes);
            }
            return;
        }
        if event.button != MouseButton::Left {
            return;
        }
        let mut term = self.terminal.term.lock();
        let (point, side) = self.grid_point(event.position, term.grid().display_offset());
        let kind = match event.click_count {
            2 => SelectionType::Semantic,
            3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        term.selection = Some(Selection::new(kind, point, side));
        drop(term);
        self.selecting = true;
        cx.notify();
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let mut term = self.terminal.term.lock();
        let (point, side) = self.grid_point(event.position, term.grid().display_offset());
        if let Some(selection) = term.selection.as_mut() {
            selection.update(point, side);
        }
        drop(term);
        cx.notify();
    }

    fn on_mouse_up(&mut self, event: &MouseUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.uses_mouse(&event.modifiers) {
            let button = match event.button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                _ => return,
            };
            if let Some(bytes) = self.mouse_report(button, false, event.position, &event.modifiers) {
                self.terminal.write(&bytes);
            }
            return;
        }
        if self.selecting {
            self.selecting = false;
            let mut term = self.terminal.term.lock();
            if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
                term.selection = None;
            }
            drop(term);
            cx.notify();
        }
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let line_height = self.layout.line_height.max(px(1.0));
        let delta = match event.delta {
            ScrollDelta::Pixels(p) => p.y / line_height,
            ScrollDelta::Lines(l) => l.y,
        };
        self.scroll_remainder += delta;
        let lines = self.scroll_remainder.trunc() as i32;
        if lines == 0 {
            return;
        }
        self.scroll_remainder -= lines as f32;
        let mode = self.mode();
        if self.uses_mouse(&event.modifiers) {
            let button = if lines > 0 { 64 } else { 65 };
            for _ in 0..lines.unsigned_abs() {
                if let Some(bytes) = self.mouse_report(button, true, event.position, &event.modifiers) {
                    self.terminal.write(&bytes);
                }
            }
        } else if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            // 全画面のプログラム（less など）には、上下のキーとして送る
            let key = if lines > 0 { b'A' } else { b'B' };
            let prefix: &[u8] = if mode.contains(TermMode::APP_CURSOR) { b"\x1bO" } else { b"\x1b[" };
            let mut bytes = Vec::new();
            for _ in 0..lines.unsigned_abs() {
                bytes.extend_from_slice(prefix);
                bytes.push(key);
            }
            self.terminal.write(&bytes);
        } else {
            self.terminal.term.lock().scroll_display(Scroll::Delta(lines));
            cx.notify();
        }
    }
}

impl Render for TerminalView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("terminal")
            .key_context("Terminal")
            .track_focus(&self.focus)
            .size_full()
            .cursor(gpui::CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::clear))
            .on_action(cx.listener(Self::open_search))
            .on_action(cx.listener(Self::find_next))
            .on_action(cx.listener(Self::find_prev))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll))
            .relative()
            .child(TerminalElement { view: cx.entity() })
            .children(self.render_search(cx))
    }
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(&mut self, _: Range<usize>, _: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let len = self.marked_text.as_ref().map(|t| t.encode_utf16().count()).unwrap_or(0);
        Some(UTF16Selection { range: len..len, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_text.as_ref().map(|t| 0..t.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked_text = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.marked_text = None;
        if !text.is_empty() {
            self.write_input(text.as_bytes(), cx);
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked_text = (!text.is_empty()).then(|| text.to_string());
        cx.notify();
    }

    // 変換候補の窓をカーソルの位置に出す
    fn bounds_for_range(&mut self, _: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let l = self.layout;
        let term = self.terminal.term.lock();
        let cursor = term.grid().cursor.point;
        let row = cursor.line.0 + term.grid().display_offset() as i32;
        Some(Bounds::new(
            point(l.origin.x + l.cell_width * cursor.column.0 as f32, l.origin.y + l.line_height * row as f32),
            size(l.cell_width, l.line_height),
        ))
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }
}

struct TerminalElement {
    view: Entity<TerminalView>,
}

struct TextPiece {
    origin: Point<Pixels>,
    line: ShapedLine,
}

// 描く順: 背景 → カーソルの四角 → 文字 → 変換中の文字
pub struct Frame {
    layout: Layout,
    quads: Vec<PaintQuad>,
    cursor: Vec<PaintQuad>,
    texts: Vec<TextPiece>,
    overlay_quads: Vec<PaintQuad>,
    overlay_texts: Vec<TextPiece>,
}

fn indexed_color(index: u8, theme: &Theme) -> Rgb {
    match index {
        0..=15 => theme.palette[index as usize],
        16..=231 => {
            const STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
            let i = index - 16;
            Rgb(STEPS[(i / 36) as usize], STEPS[(i / 6 % 6) as usize], STEPS[(i % 6) as usize])
        }
        _ => {
            let v = 8 + 10 * (index - 232);
            Rgb(v, v, v)
        }
    }
}

fn resolve_color(color: Color, colors: &Colors, theme: &Theme) -> Rgb {
    let from = |c: alacritty_terminal::vte::ansi::Rgb| Rgb(c.r, c.g, c.b);
    match color {
        Color::Spec(c) => from(c),
        Color::Indexed(i) => colors[i as usize].map(from).unwrap_or_else(|| indexed_color(i, theme)),
        Color::Named(name) => {
            if let Some(c) = colors[name as usize] {
                return from(c);
            }
            let index = name as usize;
            match name {
                NamedColor::Foreground | NamedColor::BrightForeground => theme.foreground,
                NamedColor::DimForeground => theme.foreground.mix(theme.background, 0.33),
                NamedColor::Background => theme.background,
                NamedColor::Cursor => theme.cursor,
                _ if index < 16 => theme.palette[index],
                _ if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&index) => {
                    theme.palette[index - NamedColor::DimBlack as usize].mix(theme.background, 0.33)
                }
                _ => theme.foreground,
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
struct CellStyle {
    fg: Rgb,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Frame;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Frame {
        let appearance = cx.global::<Appearance>();
        let theme = appearance.theme.clone();
        let selection_bg = appearance.chrome.selection;
        let accent = appearance.chrome.accent;
        let font = appearance.font.clone();
        let font_size = appearance.font_size;
        let padding = point(px(appearance.config.padding_x), px(appearance.config.padding_y));
        let cursor_style = appearance.config.cursor_style.clone();
        let minimum_contrast = appearance.config.minimum_contrast;
        let mut contrast_cache: std::collections::HashMap<(Rgb, Rgb), Rgb> = std::collections::HashMap::new();
        let text_system = window.text_system().clone();
        let font_id = text_system.resolve_font(&font);
        let cell_width = text_system.advance(font_id, font_size, 'm').map(|s| s.width).unwrap_or(font_size * 0.6);
        let line_height = (text_system.ascent(font_id, font_size) + text_system.descent(font_id, font_size).abs()).ceil();
        let origin = bounds.origin + padding;
        let cols = (((bounds.size.width - padding.x * 2.0) / cell_width).floor() as usize).max(2);
        let rows = (((bounds.size.height - padding.y * 2.0) / line_height).floor() as usize).max(1);
        let layout = Layout { origin, cell_width, line_height, cols, rows };

        let focused = self.view.read(cx).focus.is_focused(window);
        let marked = self.view.read(cx).marked_text.clone();
        self.view.update(cx, |view, _| {
            view.layout = layout;
            view.terminal.resize(GridSize { cols: cols as u16, rows: rows as u16 }, f32::from(cell_width) as u16, f32::from(line_height) as u16);
        });

        let view = self.view.read(cx);
        let term = view.terminal.term.lock();
        let content = term.renderable_content();
        let display_offset = content.display_offset as i32;
        let selection = content.selection;
        let colors = content.colors;
        let mut quads = Vec::new();
        let mut texts = Vec::new();
        let cell_origin = |row: i32, col: usize| point(origin.x + cell_width * col as f32, origin.y + line_height * row as f32);

        // 行ごとに、同じ見た目の続く文字をまとめて1回で描く
        let mut run: Option<(i32, usize, CellStyle, String)> = None;
        let mut bg_run: Option<(i32, usize, usize, Rgb)> = None;
        let flush_text = |run: &mut Option<(i32, usize, CellStyle, String)>, texts: &mut Vec<TextPiece>, force: Option<Pixels>| {
            if let Some((row, col, style, text)) = run.take() {
                if text.trim().is_empty() {
                    return;
                }
                let mut f = font.clone();
                if style.bold {
                    f.weight = FontWeight::BOLD;
                }
                if style.italic {
                    f.style = FontStyle::Italic;
                }
                let color = hsla(style.fg, 1.0);
                let text_run = TextRun {
                    len: text.len(),
                    font: f,
                    color,
                    background_color: None,
                    underline: style.underline.then(|| UnderlineStyle { color: Some(color), thickness: px(1.0), wavy: false }),
                    strikethrough: style.strike.then(|| StrikethroughStyle { color: Some(color), thickness: px(1.0) }),
                };
                let line = text_system.shape_line(SharedString::from(text), font_size, &[text_run], force);
                texts.push(TextPiece { origin: cell_origin(row, col), line });
            }
        };
        let flush_bg = |bg_run: &mut Option<(i32, usize, usize, Rgb)>, quads: &mut Vec<PaintQuad>| {
            if let Some((row, start, end, color)) = bg_run.take() {
                let o = cell_origin(row, start);
                quads.push(fill(Bounds::new(o, size(cell_width * (end - start) as f32, line_height)), hsla(color, 1.0)));
            }
        };

        for indexed in content.display_iter {
            let cell = indexed.cell;
            let row = indexed.point.line.0 + display_offset;
            let col = indexed.point.column.0;
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let mut fg = resolve_color(cell.fg, colors, &theme);
            let mut bg = resolve_color(cell.bg, colors, &theme);
            let mut default_bg = matches!(cell.bg, Color::Named(NamedColor::Background));
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
                default_bg = false;
            }
            if cell.flags.contains(Flags::DIM) {
                fg = fg.mix(bg, 0.33);
            }
            if cell.flags.contains(Flags::HIDDEN) {
                fg = bg;
            } else if minimum_contrast > 1.0 {
                fg = *contrast_cache.entry((fg, bg)).or_insert_with(|| ensure_contrast(fg, bg, minimum_contrast));
            }
            if selection.is_some_and(|s| s.contains(indexed.point)) {
                bg = selection_bg;
                default_bg = false;
            }
            let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };

            // 背景
            match (&mut bg_run, default_bg) {
                (Some((r, _, end, color)), false) if *r == row && *end == col && *color == bg => *end = col + width,
                (_, false) => {
                    flush_bg(&mut bg_run, &mut quads);
                    bg_run = Some((row, col, col + width, bg));
                }
                (_, true) => flush_bg(&mut bg_run, &mut quads),
            }

            // 文字
            let style = CellStyle {
                fg,
                bold: cell.flags.contains(Flags::BOLD),
                italic: cell.flags.contains(Flags::ITALIC),
                underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                strike: cell.flags.contains(Flags::STRIKEOUT),
            };
            let mut text = cell.c.to_string();
            if let Some(extra) = cell.zerowidth() {
                text.extend(extra);
            }
            if width == 2 {
                // 全角の文字は1字ずつ、2マスの位置に置く
                flush_text(&mut run, &mut texts, Some(cell_width));
                run = Some((row, col, style, text));
                flush_text(&mut run, &mut texts, None);
                continue;
            }
            match &mut run {
                Some((r, start, s, t)) if *r == row && *s == style && *start + t.chars().filter(|c| !is_zero_width(*c)).count() == col => {
                    t.push_str(&text)
                }
                _ => {
                    flush_text(&mut run, &mut texts, Some(cell_width));
                    run = Some((row, col, style, text));
                }
            }
        }
        flush_text(&mut run, &mut texts, Some(cell_width));
        flush_bg(&mut bg_run, &mut quads);

        // 探している文字の当たり。選んでいる当たりは強調色で示す
        if let Some(search) = &view.search {
            let match_bg = hsla(selection_bg, 0.85);
            let active_bg = hsla(accent.mix(theme.background, 0.35), 1.0);
            for (i, m) in search.matches.iter().enumerate() {
                let (start, end) = (*m.start(), *m.end());
                let first = start.line.0 + display_offset;
                let last = end.line.0 + display_offset;
                if last < 0 || first >= rows as i32 {
                    continue;
                }
                let color = if Some(i) == search.index { active_bg } else { match_bg };
                for row in first.max(0)..=last.min(rows as i32 - 1) {
                    let from = if row == first { start.column.0 } else { 0 };
                    let to = if row == last { end.column.0 + 1 } else { cols };
                    if to > from {
                        quads.push(fill(Bounds::new(cell_origin(row, from), size(cell_width * (to - from) as f32, line_height)), color));
                    }
                }
            }
        }

        // カーソル
        let mut cursor = Vec::new();
        let cursor_point = content.cursor.point;
        let cursor_row = cursor_point.line.0 + display_offset;
        if content.cursor.shape != CursorShape::Hidden && (0..rows as i32).contains(&cursor_row) && marked.is_none() {
            let o = cell_origin(cursor_row, cursor_point.column.0);
            let wide = term.grid()[cursor_point].flags.contains(Flags::WIDE_CHAR);
            let w = if wide { cell_width * 2.0 } else { cell_width };
            let color = hsla(theme.cursor, 1.0);
            let shape = match (content.cursor.shape, cursor_style.as_str()) {
                (CursorShape::Block, "bar") => CursorShape::Beam,
                (CursorShape::Block, "underline") => CursorShape::Underline,
                (shape, _) => shape,
            };
            match shape {
                _ if !focused => cursor.push(outline(Bounds::new(o, size(w, line_height)), color, gpui::BorderStyle::Solid)),
                CursorShape::Beam => cursor.push(fill(Bounds::new(o, size(px(2.0), line_height)), color)),
                CursorShape::Underline => {
                    cursor.push(fill(Bounds::new(point(o.x, o.y + line_height - px(2.0)), size(w, px(2.0))), color))
                }
                _ => {
                    cursor.push(fill(Bounds::new(o, size(w, line_height)), color));
                    let cell = &term.grid()[cursor_point];
                    if cell.c != ' ' {
                        let text_run = TextRun {
                            len: cell.c.len_utf8(),
                            font: font.clone(),
                            color: hsla(theme.cursor_text, 1.0),
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        let line = text_system.shape_line(SharedString::from(cell.c.to_string()), font_size, &[text_run], None);
                        texts.push(TextPiece { origin: o, line });
                    }
                }
            }
        }

        // 変換中の文字は、カーソルの位置に下線付きで重ねる
        let mut overlay_quads = Vec::new();
        let mut overlay_texts = Vec::new();
        if let Some(marked) = marked
            && (0..rows as i32).contains(&cursor_row)
        {
            let o = cell_origin(cursor_row, cursor_point.column.0);
            let color = hsla(theme.foreground, 1.0);
            let text_run = TextRun {
                len: marked.len(),
                font: font.clone(),
                color,
                background_color: None,
                underline: Some(UnderlineStyle { color: Some(color), thickness: px(1.0), wavy: false }),
                strikethrough: None,
            };
            let line = text_system.shape_line(SharedString::from(marked), font_size, &[text_run], None);
            overlay_quads.push(fill(Bounds::new(o, size(line.width, line_height)), hsla(theme.background, 1.0)));
            overlay_texts.push(TextPiece { origin: o, line });
        }

        Frame { layout, quads, cursor, texts, overlay_quads, overlay_texts }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        frame: &mut Frame,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.view.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for quad in frame.quads.drain(..) {
                window.paint_quad(quad);
            }
            let line_height = frame.layout.line_height;
            for quad in frame.cursor.drain(..) {
                window.paint_quad(quad);
            }
            for piece in frame.texts.drain(..) {
                let _ = piece.line.paint(piece.origin, line_height, TextAlign::Left, None, window, cx);
            }
            for quad in frame.overlay_quads.drain(..) {
                window.paint_quad(quad);
            }
            for piece in frame.overlay_texts.drain(..) {
                let _ = piece.line.paint(piece.origin, line_height, TextAlign::Left, None, window, cx);
            }
        });
    }
}

// 作業場所のフォルダ名。ホームは「ターミナル」と出す（「~」だけでは何の行か分かりにくい）
pub fn folder_name(cwd: &Path) -> String {
    if cwd == crate::config::home_dir() || cwd.as_os_str().is_empty() || cwd == Path::new("/") {
        return "ターミナル".into();
    }
    cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "ターミナル".into())
}

pub fn escape_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if " \t'\"\\$`!&*()[]{};<>?|#~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn terminal_paths(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let mut text = paths.iter().map(|p| escape_path(&p.display().to_string())).collect::<Vec<_>>().join(" ");
    text.push(' ');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 落としたパスは空白と記号を逃がして並べる() {
        let paths = vec![PathBuf::from("/tmp/a b/(x).txt"), PathBuf::from("/tmp/c")];
        assert_eq!(terminal_paths(&paths), "/tmp/a\\ b/\\(x\\).txt /tmp/c ");
    }
}

fn is_zero_width(c: char) -> bool {
    matches!(c as u32, 0x200b..=0x200f | 0x0300..=0x036f | 0xfe00..=0xfe0f | 0x20d0..=0x20ff)
}
