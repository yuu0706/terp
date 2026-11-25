// 窓の中身。左の一覧・枠ごとのタブ・ワークスペースと、エージェントの状態の知らせを持つ。
use crate::agent::{AgentState, clean};
use crate::appearance::{Appearance, hsla};
use crate::config::{Config, config_path, home_dir};
use crate::panes::{Axis, Direction, Layout, Node, Side, drop_side};
use crate::projects::{self, Project, Projects, contains_path};
use crate::ptyhost::SessionSummary;
use crate::terminal::{GridSize, HostClient, Terminal};
use crate::terminal_view::{Attention, TerminalEvent, TerminalView};
use gpui::{
    AnyElement, App, Bounds, ClickEvent, Context, DragMoveEvent, Entity, ExternalPaths, FocusHandle, Focusable, FontWeight, Hsla, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, SharedString, Subscription, SystemNotification,
    Task, Window, WindowBackgroundAppearance, actions, canvas, div, prelude::*, px,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

actions!(
    terp,
    [
        NewTerminal,
        SplitRight,
        CloseTab,
        NextTab,
        PrevTab,
        RecentTab,
        NextAttention,
        PaneLeft,
        PaneRight,
        PaneUp,
        PaneDown,
        SelectTab1,
        SelectTab2,
        SelectTab3,
        SelectTab4,
        SelectTab5,
        SelectTab6,
        SelectTab7,
        SelectTab8,
        SelectTab9,
        Workspace1,
        Workspace2,
        Workspace3,
        Workspace4,
        Workspace5,
        Workspace6,
        Workspace7,
        Workspace8,
        Workspace9,
        WorkspaceNext,
        WorkspacePrev,
        ToggleSidebar,
        FontBigger,
        FontSmaller,
        FontReset,
        OpenConfig,
    ]
);

const SIDEBAR_WIDTH: f32 = 248.0;
const TAB_BAR_HEIGHT: f32 = 38.0;
const DIVIDER: f32 = 4.0;
// 信号機のボタン（閉じる・しまう・広げる）を避ける幅
const TRAFFIC_LIGHT_SPACE: f32 = 78.0;
const NOTIFY_INTERVAL: Duration = Duration::from_secs(3);

struct Session {
    id: u64,
    view: Entity<TerminalView>,
    workspace: String,
    last_notify: Option<Instant>,
    _subscriptions: [Subscription; 2],
}

// ドラッグしているタブ。落とした枠の端なら分割し、真ん中ならその枠のタブにする
#[derive(Clone)]
pub struct DraggedTab {
    id: u64,
    label: String,
}

impl Render for DraggedTab {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        div()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(p.accent)
            .bg(p.accent_fill)
            .text_sm()
            .text_color(p.text)
            .font_family(cx.global::<Appearance>().font.family.clone())
            .child(self.label.clone())
    }
}

struct DividerDrag {
    workspace: String,
    path: Vec<usize>,
    index: usize,
    axis: Axis,
    last: Point<Pixels>,
}

pub struct TerpApp {
    focus: FocusHandle,
    sessions: Vec<Session>,
    next_id: u64,
    layouts: HashMap<String, Layout>,
    recent: Vec<u64>,
    projects: Projects,
    sidebar: bool,
    font_delta: f32,
    config_mtime: Option<SystemTime>,
    notice: Option<String>,
    dock_count: usize,
    drag: Option<DividerDrag>,
    split_bounds: Rc<RefCell<HashMap<Vec<usize>, Bounds<Pixels>>>>,
    pane_bounds: HashMap<u64, Bounds<Pixels>>,
    drop_hint: Option<(u64, Side)>,
    host: Option<Arc<HostClient>>,
    _poll: Task<()>,
}

pub fn load_appearance(font_delta: f32, cx: &mut App) {
    let (config, error) = Config::load(&config_path());
    let appearance = Appearance::build(config, error, font_delta, cx);
    cx.set_global(appearance);
}

pub fn background_appearance(cx: &App) -> WindowBackgroundAppearance {
    let config = &cx.global::<Appearance>().config;
    // ぼかしは dock::set_blur_radius で半径を指定して掛ける
    if config.background_opacity >= 1.0 { WindowBackgroundAppearance::Opaque } else { WindowBackgroundAppearance::Transparent }
}

pub fn apply_blur(cx: &App) {
    let config = &cx.global::<Appearance>().config;
    let radius = if config.background_opacity < 1.0 { config.background_blur.radius() } else { 0 };
    crate::dock::set_blur_radius(radius);
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

// 作業場所をホームからの書き方に縮める
pub fn short_path(path: &Path) -> String {
    let home = home_dir();
    match path.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

#[derive(Clone)]
struct Palette {
    bg: Hsla,
    term_bg: Hsla,
    hover: Hsla,
    active: Hsla,
    border: Hsla,
    text: Hsla,
    muted: Hsla,
    accent: Hsla,
    accent_fill: Hsla,
    accent_fill_dim: Hsla,
    busy: Hsla,
    warning: Hsla,
}

fn palette(cx: &App) -> Palette {
    let a = cx.global::<Appearance>();
    let c = &a.chrome;
    let opacity = a.opacity();
    Palette {
        bg: hsla(c.bg, opacity),
        term_bg: hsla(c.term_bg, opacity),
        hover: hsla(c.bg_hover, 1.0),
        active: hsla(c.bg_active, 1.0),
        border: hsla(c.border, 1.0),
        text: hsla(c.text, 1.0),
        muted: hsla(c.text_muted, 1.0),
        accent: hsla(c.accent, 1.0),
        accent_fill: hsla(c.bg.mix(c.accent, c.accent_fill), 1.0),
        accent_fill_dim: hsla(c.bg.mix(c.accent, c.accent_fill * 12.0 / 22.0), 1.0),
        busy: hsla(a.theme.palette[2], 1.0),
        warning: hsla(a.theme.palette[3], 1.0),
    }
}

// 状態の印。考え中は緑、許可待ちは黄の「!」、終わったは強調色、ベルは黄
fn status_dot(state: AgentState, bell: bool, p: &Palette) -> Option<AnyElement> {
    let (color, mark) = match state {
        AgentState::Working => (p.busy, ""),
        AgentState::Waiting => (p.warning, "!"),
        AgentState::Done => (p.accent, ""),
        AgentState::Idle if bell => (p.warning, ""),
        AgentState::Idle => return None,
    };
    Some(
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(if mark.is_empty() { 7.0 } else { 13.0 }))
            .rounded_full()
            .bg(color)
            .text_color(p.bg)
            .text_size(px(10.0))
            .font_weight(FontWeight::BOLD)
            .child(mark)
            .into_any_element(),
    )
}

impl TerpApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let poll = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update_in(cx, |app, window, cx| app.poll(window, cx)).is_err() {
                    break;
                }
            }
        });
        // 通知を押したら、その端末へ移る
        let handle = window.window_handle();
        let weak = cx.entity().downgrade();
        cx.on_system_notification_response(move |response, cx| {
            let Some(id) = response.tag.strip_prefix("terp-").and_then(|s| s.parse::<u64>().ok()) else { return };
            let weak = weak.clone();
            let _ = handle.update(cx, |_, window, cx| {
                window.activate_window();
                let _ = weak.update(cx, |app, cx| app.select(id, window, cx));
            });
            cx.activate(true);
        });
        let mut app = TerpApp {
            focus: cx.focus_handle(),
            sessions: Vec::new(),
            next_id: 1,
            layouts: HashMap::new(),
            recent: Vec::new(),
            projects: Projects::load(),
            sidebar: true,
            font_delta: 0.0,
            config_mtime: mtime(&config_path()),
            notice: None,
            dock_count: 0,
            drag: None,
            split_bounds: Rc::default(),
            pane_bounds: HashMap::new(),
            drop_hint: None,
            host: None,
            _poll: poll,
        };
        match HostClient::connect() {
            Ok((host, sessions)) => {
                app.host = Some(host);
                app.restore_sessions(sessions, window, cx);
            }
            Err(err) => {
                app.notice = Some(format!("終了後もシェルを残す常駐のプロセスを使えない（{err}）。この窓を閉じるとシェルも終わる"));
            }
        }
        match app.active_id() {
            Some(id) => app.select(id, window, cx),
            None => app.open_terminal(home_dir(), window, cx),
        }
        app
    }

    fn workspace(&self) -> String {
        self.projects.active_workspace.clone()
    }

    fn layout(&self) -> Option<&Layout> {
        self.layouts.get(&self.workspace())
    }

    fn layout_mut(&mut self) -> &mut Layout {
        let ws = self.workspace();
        self.layouts.entry(ws).or_default()
    }

    fn session(&self, id: u64) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    fn active_id(&self) -> Option<u64> {
        self.layout().and_then(|l| l.active_tab()).filter(|id| self.session(*id).is_some())
    }

    fn workspace_ids(&self, workspace: &str) -> Vec<u64> {
        self.sessions.iter().filter(|s| s.workspace == workspace).map(|s| s.id).collect()
    }

    fn is_visible(&self, id: u64) -> bool {
        self.session(id).is_some_and(|s| s.workspace == self.workspace())
            && self.layout().is_some_and(|l| l.visible().contains(&id))
    }

    // 1秒ごとに、動いているプログラム・作業場所・設定・ワークスペースの変更と、見た端末の印を確かめる
    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focused = window.is_window_active();
        let visible: Vec<u64> = self.layout().map(|l| l.visible()).unwrap_or_default();
        for session in &self.sessions {
            let seen = focused && visible.contains(&session.id) && session.workspace == self.workspace();
            session.view.update(cx, |view, cx| {
                view.refresh_process(cx);
                if seen {
                    view.mark_seen();
                }
            });
        }
        let current = mtime(&config_path());
        if current != self.config_mtime {
            self.config_mtime = current;
            self.reload_appearance(window, cx);
        }
        let projects = Projects::load();
        if projects.workspaces != self.projects.workspaces || projects.projects != self.projects.projects {
            // 表示中のワークスペースは、この窓での切り替えを優先する
            let active = self.projects.active_workspace.clone();
            self.projects = projects;
            if self.projects.workspaces.iter().any(|w| w.id == active) {
                self.projects.active_workspace = active;
            }
        }
        self.update_dock(cx);
        // 経過の表示（考え中 1:23 など）を進める
        cx.notify();
    }

    fn attention_ids(&self, cx: &App) -> Vec<(u64, AgentState)> {
        self.sessions
            .iter()
            .map(|s| (s.id, s.view.read(cx).agent_state()))
            .filter(|(_, state)| matches!(state, AgentState::Waiting | AgentState::Done))
            .collect()
    }

    fn update_dock(&mut self, cx: &mut Context<Self>) {
        let count = if cx.global::<Appearance>().config.dock_badge { self.attention_ids(cx).len() } else { 0 };
        if count != self.dock_count {
            self.dock_count = count;
            crate::dock::set_badge(count);
        }
    }

    fn reload_appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        load_appearance(self.font_delta, cx);
        crate::bind_keys(cx);
        window.set_background_appearance(background_appearance(cx));
        apply_blur(cx);
        cx.refresh_windows();
    }

    fn spawn_session(&mut self, cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Option<u64> {
        let cwd = if cwd.is_dir() { cwd } else { home_dir() };
        let size = GridSize { cols: 80, rows: 24 };
        let meta = serde_json::json!({ "workspace": self.workspace() });
        let created = match &self.host {
            Some(host) => Terminal::create_remote(host, &cwd, size, meta),
            None => Terminal::spawn_local(&cwd, size),
        };
        let (terminal, events) = match created {
            Ok(parts) => parts,
            Err(err) => {
                self.notice = Some(format!("ターミナルを開けない: {err}"));
                cx.notify();
                return None;
            }
        };
        let view = TerminalView::new(terminal, events, &cwd, cx);
        let workspace = self.workspace();
        Some(self.add_session(view, workspace, window, cx))
    }

    fn add_session(&mut self, view: Entity<TerminalView>, workspace: String, window: &mut Window, cx: &mut Context<Self>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let events = cx.subscribe_in(&view, window, move |app, _, event, window, cx| match event {
            TerminalEvent::Exited => app.close(id, window, cx),
            TerminalEvent::Changed => cx.notify(),
            TerminalEvent::Attention { kind, message } => app.on_attention(id, *kind, message.clone(), window, cx),
        });
        // 端末を押して入力を移したら、その枠とタブを選ぶ
        let focus_handle = view.read(cx).focus_handle(cx);
        let focus = cx.on_focus(&focus_handle, window, move |app, window, cx| app.select(id, window, cx));
        self.sessions.push(Session { id, view, workspace, last_notify: None, _subscriptions: [events, focus] });
        id
    }

    // 前に開いていた端末（PTY ホストに残っているシェル）へつなぎ直し、ワークスペースごとのタブに戻す
    fn restore_sessions(&mut self, sessions: Vec<SessionSummary>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(host) = self.host.clone() else { return };
        for summary in sessions {
            let workspace = summary
                .meta
                .get("workspace")
                .and_then(|w| w.as_str())
                .filter(|w| self.projects.workspaces.iter().any(|x| x.id == *w))
                .map(String::from)
                .unwrap_or_else(|| self.workspace());
            let (terminal, events) = Terminal::attach_remote(&host, summary.id, summary.size);
            let view = TerminalView::new(terminal, events, &summary.cwd, cx);
            let id = self.add_session(view, workspace.clone(), window, cx);
            self.layouts.entry(workspace).or_default().add_tab(id);
        }
    }

    pub fn open_terminal(&mut self, cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.spawn_session(cwd, window, cx) {
            self.layout_mut().add_tab(id);
            self.select(id, window, cx);
        }
    }

    fn active_cwd(&self, cx: &App) -> PathBuf {
        self.active_id().and_then(|id| self.session(id)).map(|s| s.view.read(cx).cwd()).unwrap_or_else(home_dir)
    }

    fn split_right(&mut self, _: &SplitRight, window: &mut Window, cx: &mut Context<Self>) {
        if self.layout().is_some_and(|l| l.panes.len() >= crate::panes::MAX_PANES) {
            self.notice = Some(format!("枠は {} つまでです", crate::panes::MAX_PANES));
            cx.notify();
            return;
        }
        let cwd = self.active_cwd(cx);
        if let Some(id) = self.spawn_session(cwd, window, cx) {
            self.layout_mut().split(Axis::Row, id);
            self.select(id, window, cx);
        }
    }

    fn select(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let workspace = session.workspace.clone();
        let view = session.view.clone();
        if workspace != self.workspace() {
            self.set_workspace(&workspace, window, cx);
        }
        let previous = self.active_id();
        self.layout_mut().select(id);
        if let Some(previous) = previous
            && previous != id
        {
            self.recent.retain(|r| *r != previous);
            self.recent.push(previous);
        }
        view.update(cx, |view, cx| {
            view.mark_seen();
            if !view.focus_handle(cx).is_focused(window) {
                view.focus(window, cx);
            }
        });
        self.notice = None;
        cx.notify();
    }

    fn close(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.session(id).map(|s| s.workspace.clone()) else { return };
        // タブを閉じたときは、PTY ホストのシェルも終わらせる
        if let Some(session) = self.session(id) {
            session.view.update(cx, |view, _| view.terminal.kill());
        }
        let was_active = self.active_id() == Some(id);
        let recent = self.recent.clone();
        if let Some(layout) = self.layouts.get_mut(&workspace) {
            layout.remove_tab(id, &recent);
        }
        self.sessions.retain(|s| s.id != id);
        self.recent.retain(|r| *r != id);
        if was_active {
            match self.active_id() {
                Some(next) => self.select(next, window, cx),
                None => window.focus(&self.focus, cx),
            }
        }
        cx.notify();
    }

    // 応答の終わり・許可待ち・ベルを、状態の印と macOS の通知にする
    fn on_attention(&mut self, id: u64, kind: Attention, message: String, window: &mut Window, cx: &mut Context<Self>) {
        let focused = window.is_window_active();
        let visible = self.is_visible(id);
        let Some(session) = self.session(id) else { return };
        let view = session.view.clone();
        if kind == Attention::Done {
            view.update(cx, |view, cx| view.mark_done(&message, focused && visible, cx));
        }
        let config = &cx.global::<Appearance>().config;
        let allowed = config.notifications
            && match kind {
                Attention::Done => config.notify_agent_done,
                Attention::Bell => config.notify_bell,
            }
            && (config.notify_when_visible || !(focused && visible))
            && session.last_notify.is_none_or(|t| t.elapsed() >= NOTIFY_INTERVAL);
        if allowed {
            let (title, body) = {
                let view = view.read(cx);
                let place = self
                    .projects
                    .projects
                    .iter()
                    .filter(|p| contains_path(&p.path, &view.cwd().display().to_string()))
                    .max_by_key(|p| p.path.len())
                    .map(|p| p.name().to_string())
                    .unwrap_or_else(|| short_path(&view.cwd()));
                let text = Some(clean(&message)).filter(|m| !m.is_empty()).unwrap_or_else(|| {
                    match kind {
                        Attention::Done => "応答が終わった",
                        Attention::Bell => "ベルが鳴った",
                    }
                    .to_string()
                });
                (format!("{} · {place}", clean(&view.display_name())), text.chars().take(200).collect::<String>())
            };
            cx.show_system_notification(SystemNotification {
                tag: format!("terp-{id}").into(),
                title: title.into(),
                body: body.into(),
                actions: Vec::new(),
            });
            if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                session.last_notify = Some(Instant::now());
            }
        }
        self.update_dock(cx);
        cx.notify();
    }

    fn set_workspace(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.projects.active_workspace == id || !self.projects.workspaces.iter().any(|w| w.id == id) {
            return;
        }
        self.projects.active_workspace = id.to_string();
        if let Err(err) = projects::save_active_workspace(id) {
            self.notice = Some(format!("ワークスペースの切り替えを記録できない: {err}"));
        }
        match self.active_id().and_then(|a| self.session(a)).map(|s| s.view.clone()) {
            Some(view) => view.update(cx, |view, cx| view.focus(window, cx)),
            None => window.focus(&self.focus, cx),
        }
        cx.notify();
    }

    // ⌘1〜⌘9 と前後の移動は、操作中の枠のタブの並びに従う
    fn pane_tabs(&self) -> Vec<u64> {
        self.layout().map(|l| l.active().tabs.clone()).unwrap_or_default()
    }

    fn cycle_tab(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.pane_tabs();
        if ids.is_empty() {
            return;
        }
        let current = self.active_id().and_then(|a| ids.iter().position(|x| *x == a)).unwrap_or(0) as isize;
        let next = (current + step).rem_euclid(ids.len() as isize) as usize;
        self.select(ids[next], window, cx);
    }

    fn select_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.pane_tabs();
        // ⌘9 は最後のタブ
        let target = if index == 8 { ids.last() } else { ids.get(index) };
        if let Some(id) = target.copied() {
            self.select(id, window, cx);
        }
    }

    fn focus_neighbor(&mut self, direction: Direction, window: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = self.layout() else { return };
        let Some(pane) = layout.neighbor(direction) else { return };
        if let Some(id) = layout.pane(pane).and_then(|p| p.active) {
            self.select(id, window, cx);
        }
    }

    fn workspace_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.projects.workspaces.get(index).map(|w| w.id.clone()) {
            self.set_workspace(&id, window, cx);
        }
    }

    fn cycle_workspace(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let list = &self.projects.workspaces;
        let current = list.iter().position(|w| w.id == self.projects.active_workspace).unwrap_or(0) as isize;
        let next = (current + step).rem_euclid(list.len() as isize) as usize;
        let id = list[next].id.clone();
        self.set_workspace(&id, window, cx);
    }

    fn new_terminal(&mut self, _: &NewTerminal, window: &mut Window, cx: &mut Context<Self>) {
        // 表示中と同じ作業場所で開く
        let cwd = self.active_cwd(cx);
        self.open_terminal(cwd, window, cx);
    }

    fn close_tab(&mut self, _: &CloseTab, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.active_id() {
            self.close(id, window, cx);
        } else {
            window.remove_window();
        }
    }

    fn recent_tab(&mut self, _: &RecentTab, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.workspace();
        let ids = self.workspace_ids(&ws);
        if let Some(id) = self.recent.iter().rev().find(|r| ids.contains(r) && Some(**r) != self.active_id()).copied() {
            self.select(id, window, cx);
        }
    }

    // 要対応（許可待ちを先に）の端末を、一覧の順に巡る
    fn next_attention(&mut self, _: &NextAttention, window: &mut Window, cx: &mut Context<Self>) {
        let order = self.list_order(cx);
        let attention = self.attention_ids(cx);
        let urgent = if attention.iter().any(|(_, s)| *s == AgentState::Waiting) { AgentState::Waiting } else { AgentState::Done };
        let targets: Vec<u64> = order.iter().copied().filter(|id| attention.contains(&(*id, urgent))).collect();
        if targets.is_empty() {
            return;
        }
        let at = self.active_id().and_then(|a| order.iter().position(|x| *x == a));
        let next = targets
            .iter()
            .copied()
            .find(|id| order.iter().position(|x| x == id) > at)
            .unwrap_or(targets[0]);
        self.select(next, window, cx);
    }

    // 左の一覧の並び（ワークスペースの順に、リポジトリごと、残りは最後）
    fn list_order(&self, cx: &App) -> Vec<u64> {
        let mut order = Vec::new();
        for w in &self.projects.workspaces {
            for group in self.groups(&w.id, cx) {
                order.extend(group.1);
            }
        }
        order
    }

    // ドラフトのリポジトリごとに、その中で動いている端末をまとめる。どれにも入らない端末は最後の None に入れる
    fn groups(&self, workspace: &str, cx: &App) -> Vec<(Option<Project>, Vec<u64>)> {
        let ids = self.workspace_ids(workspace);
        let drafts: Vec<Project> = self.projects.projects.iter().filter(|p| p.workspace == workspace && p.draft).cloned().collect();
        let owner = |id: u64| -> Option<String> {
            let cwd = self.session(id)?.view.read(cx).cwd().display().to_string();
            drafts.iter().filter(|p| contains_path(&p.path, &cwd)).max_by_key(|p| p.path.len()).map(|p| p.path.clone())
        };
        let owners: HashMap<u64, Option<String>> = ids.iter().map(|id| (*id, owner(*id))).collect();
        let mut groups: Vec<(Option<Project>, Vec<u64>)> = drafts
            .iter()
            .map(|p| (Some(p.clone()), ids.iter().copied().filter(|id| owners[id].as_deref() == Some(p.path.as_str())).collect()))
            .collect();
        groups.push((None, ids.iter().copied().filter(|id| owners[id].is_none()).collect()));
        groups
    }

    fn set_font_delta(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.font_delta = delta;
        self.reload_appearance(window, cx);
    }

    fn open_config(&mut self, _: &OpenConfig, _window: &mut Window, cx: &mut Context<Self>) {
        let path = config_path();
        if !path.exists() {
            let _ = std::fs::create_dir_all(crate::config::config_dir());
            let _ = std::fs::write(&path, "{}\n");
        }
        cx.open_with_system(&path);
    }

    fn on_drag_move(&mut self, event: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.as_mut() else { return };
        if event.pressed_button != Some(MouseButton::Left) {
            self.drag = None;
            return;
        }
        let Some(bounds) = self.split_bounds.borrow().get(&drag.path).copied() else { return };
        let (delta, total) = match drag.axis {
            Axis::Row => (event.position.x - drag.last.x, bounds.size.width),
            Axis::Column => (event.position.y - drag.last.y, bounds.size.height),
        };
        if total <= px(0.0) {
            return;
        }
        drag.last = event.position;
        let (workspace, path, index) = (drag.workspace.clone(), drag.path.clone(), drag.index);
        if let Some(layout) = self.layouts.get_mut(&workspace) {
            layout.resize(&path, index, delta / total);
        }
        cx.notify();
    }

    fn on_drag_end(&mut self, _: &MouseUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.drag.take().is_some() || self.drop_hint.take().is_some() {
            cx.notify();
        }
    }

    fn drop_position(&self, pane: u64, window: &Window) -> Side {
        let Some(bounds) = self.pane_bounds.get(&pane) else { return Side::Center };
        let at = window.mouse_position() - bounds.origin;
        let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        if w <= 0.0 || h <= 0.0 {
            return Side::Center;
        }
        drop_side(f32::from(at.x) / w, f32::from(at.y) / h)
    }

    fn on_tab_drag_move(&mut self, pane: u64, event: &DragMoveEvent<DraggedTab>, window: &mut Window, cx: &mut Context<Self>) {
        self.pane_bounds.insert(pane, event.bounds);
        let hint = if event.bounds.contains(&event.event.position) {
            Some((pane, self.drop_position(pane, window)))
        } else if self.drop_hint.is_some_and(|(p, _)| p == pane) {
            None
        } else {
            return;
        };
        if hint != self.drop_hint {
            self.drop_hint = hint;
            cx.notify();
        }
    }

    // タブを枠へ落とす。自分の枠の端へ落として元の枠が空いたら、1つ前に見ていた未表示のタブか、新しい端末で埋める
    fn drop_tab(&mut self, tab: u64, pane: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.drop_hint = None;
        let Some(session) = self.session(tab) else { return };
        if session.workspace != self.workspace() {
            return;
        }
        let cwd = session.view.read(cx).cwd();
        let side = self.drop_position(pane, window);
        if let Some(empty) = self.layout_mut().move_tab(tab, pane, side) {
            let visible = self.layout().map(|l| l.visible()).unwrap_or_default();
            let ids = self.workspace_ids(&self.workspace());
            let hidden = self.recent.iter().rev().copied().find(|r| *r != tab && ids.contains(r) && !visible.contains(r));
            match hidden {
                Some(other) => {
                    self.layout_mut().move_tab(other, empty, Side::Center);
                }
                None => {
                    if let Some(id) = self.spawn_session(cwd, window, cx) {
                        self.layout_mut().move_tab(id, empty, Side::Center);
                    }
                }
            }
        }
        self.select(tab, window, cx);
    }

    fn drop_paths(&mut self, pane: u64, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.layout().and_then(|l| l.pane(pane)).and_then(|p| p.active) else { return };
        self.select(id, window, cx);
        if let Some(session) = self.session(id) {
            let paths = paths.paths().to_vec();
            session.view.update(cx, |view, cx| view.input_paths(&paths, cx));
        }
    }

    fn render_node(&self, node: &Node, path: Vec<usize>, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match node {
            Node::Leaf(pane) => self.render_pane(*pane, p, window, cx),
            Node::Split { axis, children, sizes } => {
                let axis = *axis;
                let record = self.split_bounds.clone();
                let key = path.clone();
                let mut container = div()
                    .relative()
                    .flex()
                    .size_full()
                    .min_w_0()
                    .min_h_0()
                    .when(axis == Axis::Row, |d| d.flex_row())
                    .when(axis == Axis::Column, |d| d.flex_col())
                    .child(
                        canvas(move |bounds, _, _| { record.borrow_mut().insert(key, bounds); }, |_, _, _, _| {})
                            .absolute()
                            .size_full(),
                    );
                for (i, (child, size)) in children.iter().zip(sizes).enumerate() {
                    if i > 0 {
                        let workspace = self.workspace();
                        let path = path.clone();
                        container = container.child(
                            div()
                                .id(SharedString::from(format!("divider-{path:?}-{i}")))
                                .flex_none()
                                .bg(p.border)
                                .when(axis == Axis::Row, |d| d.w(px(DIVIDER)).h_full().cursor_col_resize())
                                .when(axis == Axis::Column, |d| d.h(px(DIVIDER)).w_full().cursor_row_resize())
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(move |app, event: &MouseDownEvent, _, cx| {
                                        cx.stop_propagation();
                                        if event.click_count == 2 {
                                            if let Some(layout) = app.layouts.get_mut(&workspace) {
                                                layout.equalize(&path);
                                            }
                                            cx.notify();
                                            return;
                                        }
                                        app.drag = Some(DividerDrag {
                                            workspace: workspace.clone(),
                                            path: path.clone(),
                                            index: i - 1,
                                            axis,
                                            last: event.position,
                                        });
                                    }),
                                ),
                        );
                    }
                    let mut child_path = path.clone();
                    child_path.push(i);
                    container = container.child(
                        div()
                            .flex()
                            .flex_basis(gpui::relative(*size))
                            .flex_grow(0.0)
                            .flex_shrink(1.0)
                            .min_w_0()
                            .min_h_0()
                            .child(self.render_node(child, child_path, p, window, cx)),
                    );
                }
                container.into_any_element()
            }
        }
    }

    fn render_pane(&self, pane_id: u64, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(layout) = self.layout() else { return div().into_any_element() };
        let Some(pane) = layout.pane(pane_id) else { return div().into_any_element() };
        let rect = layout.rects().into_iter().find(|(id, _)| *id == pane_id).map(|(_, r)| r);
        let at_top = rect.is_some_and(|r| r.y < 1e-4);
        let at_left = rect.is_some_and(|r| r.x < 1e-4);
        let pane_active = layout.active_pane == pane_id && layout.panes.len() > 1;
        let now = Instant::now();
        let accent = p.accent;

        let mut bar = div()
            .id(("tab-bar", pane_id))
            .flex()
            .flex_row()
            .items_center()
            .h(px(TAB_BAR_HEIGHT))
            .flex_none()
            .gap_1()
            .px_2()
            .border_b_1()
            .border_color(if pane_active { p.accent } else { p.border })
            .bg(p.bg)
            .overflow_x_hidden()
            .when(at_top, |d| {
                d.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
                    if event.click_count == 2 {
                        window.titlebar_double_click();
                    } else {
                        window.start_window_move();
                    }
                })
            });
        if !self.sidebar && at_top && at_left {
            bar = bar.pl(px(TRAFFIC_LIGHT_SPACE));
        }
        for (index, id) in pane.tabs.iter().copied().enumerate() {
            let Some(session) = self.session(id) else { continue };
            let view = session.view.read(cx);
            let selected = pane.active == Some(id);
            let label = format!("{}  {}", index + 1, view.display_name());
            let state = view.agent_state();
            let dot = status_dot(state, view.unseen_bell, p);
            let tip = view.agent.text(now);
            bar = bar.child(
                div()
                    .id(("tab", id))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .h(px(26.0))
                    .max_w(px(240.0))
                    .px_2()
                    .rounded_md()
                    .text_sm()
                    .text_color(if selected { p.text } else { p.muted })
                    .when(selected, |d| d.bg(if layout.active_pane == pane_id { p.accent_fill } else { p.accent_fill_dim }))
                    .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
                    .on_drag(DraggedTab { id, label: view.display_name() }, |tab, _, _, cx| cx.new(|_| tab.clone()))
                    .drag_over::<DraggedTab>(move |s, _, _, _| s.border_l_2().border_color(accent))
                    .on_drop(cx.listener(move |app, dragged: &DraggedTab, window, cx| {
                        cx.stop_propagation();
                        app.layout_mut().reorder(dragged.id, id);
                        app.select(dragged.id, window, cx);
                    }))
                    .when_some(dot, |d, dot| d.child(dot))
                    .child(div().overflow_hidden().text_ellipsis().whitespace_nowrap().child(label))
                    .when(!tip.is_empty() && state == AgentState::Working, |d| {
                        d.child(div().flex_none().text_xs().text_color(p.muted).child(tip.trim_start_matches("考え中 ").to_string()))
                    })
                    .child(
                        div()
                            .id(("close", id))
                            .px_1()
                            .rounded_sm()
                            .text_color(p.muted)
                            .hover(|s| s.bg(p.active).text_color(p.text))
                            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                                cx.stop_propagation();
                                app.close(id, window, cx);
                            }))
                            .child("×"),
                    ),
            );
        }
        let bar = bar.child(
            div()
                .id(("new-tab", pane_id))
                .px_2()
                .h(px(26.0))
                .flex()
                .items_center()
                .rounded_md()
                .text_color(p.muted)
                .hover(|s| s.bg(p.hover).text_color(p.text))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                    if let Some(layout) = app.layouts.get_mut(&app.projects.active_workspace) {
                        layout.focus_pane(pane_id);
                    }
                    app.new_terminal(&NewTerminal, window, cx);
                }))
                .child("＋"),
        );

        let hint = self.drop_hint.filter(|(id, _)| *id == pane_id).map(|(_, side)| side);
        let content: AnyElement = match pane.active.and_then(|id| self.session(id)) {
            Some(session) => div().size_full().bg(p.term_bg).child(session.view.clone()).into_any_element(),
            None => div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .bg(p.term_bg)
                .text_color(p.muted)
                .child("このワークスペースにターミナルはありません")
                .child(
                    div()
                        .id("empty-new")
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(p.border)
                        .text_color(p.text)
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.new_terminal(&NewTerminal, window, cx)))
                        .child("新しいターミナル（⌘T）"),
                )
                .into_any_element(),
        };
        let _ = window;
        // 落とす位置の予告。端ならその側の半分、真ん中なら全体を薄く塗る
        let preview = hint.map(|side| {
            let d = div().absolute().bg(p.accent.opacity(0.22)).border_2().border_color(p.accent).rounded_md();
            match side {
                Side::Left => d.left_0().top_0().bottom_0().w(gpui::relative(0.5)),
                Side::Right => d.right_0().top_0().bottom_0().w(gpui::relative(0.5)),
                Side::Top => d.left_0().right_0().top_0().h(gpui::relative(0.5)),
                Side::Bottom => d.left_0().right_0().bottom_0().h(gpui::relative(0.5)),
                Side::Center => d.inset_0(),
            }
        });
        let body = div()
            .id(("pane-body", pane_id))
            .relative()
            .flex_1()
            .min_h_0()
            .child(content)
            .children(preview)
            .on_drag_move::<DraggedTab>(cx.listener(move |app, event: &DragMoveEvent<DraggedTab>, window, cx| {
                app.on_tab_drag_move(pane_id, event, window, cx)
            }))
            .on_drop(cx.listener(move |app, dragged: &DraggedTab, window, cx| app.drop_tab(dragged.id, pane_id, window, cx)))
            .drag_over::<ExternalPaths>(move |s, _, _, _| s.border_2().border_color(accent))
            .on_drop(cx.listener(move |app, paths: &ExternalPaths, window, cx| app.drop_paths(pane_id, paths, window, cx)));
        div().flex().flex_col().size_full().min_w_0().min_h_0().child(bar).child(body).into_any_element()
    }

    fn render_terminal_row(&self, id: u64, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let session = self.session(id).expect("一覧の端末は開いている");
        let view = session.view.read(cx);
        let selected = self.active_id() == Some(id);
        let visible = self.is_visible(id);
        let state = view.agent_state();
        let program = view.process.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        let status = view.agent.text(Instant::now());
        let detail = if view.is_agent() && !status.is_empty() {
            format!("{status} · {}", short_path(&view.cwd()))
        } else {
            format!("{program} · {}", short_path(&view.cwd()))
        };
        let dot = status_dot(state, view.unseen_bell, p);
        div()
            .id(("row", id))
            .flex()
            .flex_col()
            .mx_2()
            .px_2()
            .py_1()
            .rounded_md()
            .when(selected, |d| d.bg(p.accent_fill))
            .when(!selected && visible, |d| d.bg(p.accent_fill_dim))
            .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
            .on_drag(DraggedTab { id, label: view.display_name() }, |tab, _, _, cx| cx.new(|_| tab.clone()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .text_sm()
                    .text_color(p.text)
                    .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(view.display_name()))
                    .when_some(dot, |d, dot| d.child(dot)),
            )
            .child(div().text_xs().text_color(p.muted).overflow_hidden().text_ellipsis().whitespace_nowrap().child(detail))
            .into_any_element()
    }

    fn render_sidebar(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let ws = self.workspace();
        let mut workspaces = div().flex().flex_row().flex_wrap().gap_1().px_2().pb_2();
        for (index, w) in self.projects.workspaces.iter().enumerate() {
            let selected = w.id == ws;
            let id = w.id.clone();
            let ids = self.workspace_ids(&w.id);
            let attention = ids.iter().any(|i| {
                self.session(*i).is_some_and(|s| matches!(s.view.read(cx).agent_state(), AgentState::Waiting | AgentState::Done))
            });
            let label = if ids.is_empty() { w.name.clone() } else { format!("{} {}", w.name, ids.len()) };
            workspaces = workspaces.child(
                div()
                    .id(("workspace", index))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .py(px(2.0))
                    .rounded_md()
                    .text_xs()
                    .border_1()
                    .border_color(if selected { p.accent } else { p.border })
                    .text_color(if selected { p.text } else { p.muted })
                    .when(selected, |d| d.bg(p.accent_fill))
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.set_workspace(&id, window, cx)))
                    .child(label)
                    .when(attention && !selected, |d| d.child(div().size(px(6.0)).rounded_full().bg(p.accent))),
            );
        }

        let mut list = div().id("sidebar-list").flex().flex_col().flex_1().overflow_y_scroll().gap(px(2.0)).pb_2();
        let groups = self.groups(&ws, cx);
        let has_projects = groups.iter().any(|(p, _)| p.is_some());
        for (project, members) in groups {
            match project {
                Some(project) => {
                    let path = PathBuf::from(&project.path);
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("project-{}", project.path)))
                            .flex()
                            .flex_row()
                            .items_center()
                            .mt_2()
                            .mx_2()
                            .px_2()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.muted)
                            .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(project.name().to_string()))
                            .child(
                                div()
                                    .id(SharedString::from(format!("open-{}", project.path)))
                                    .px_1()
                                    .rounded_sm()
                                    .hover(|s| s.bg(p.hover).text_color(p.text))
                                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.open_terminal(path.clone(), window, cx)))
                                    .child("＋"),
                            ),
                    );
                }
                None if members.is_empty() => continue,
                None if has_projects => {
                    list = list.child(div().mt_2().mx_2().px_2().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.muted).child("その他"));
                }
                None => {}
            }
            for id in members {
                list = list.child(self.render_terminal_row(id, p, cx));
            }
        }

        div()
            .flex()
            .flex_col()
            .w(px(SIDEBAR_WIDTH))
            .flex_none()
            .h_full()
            .bg(p.bg)
            .border_r_1()
            .border_color(p.border)
            .child(
                div()
                    .id("sidebar-titlebar")
                    .h(px(TAB_BAR_HEIGHT))
                    .flex_none()
                    .on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
                        if event.click_count == 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    }),
            )
            .child(workspaces)
            .child(list)
            .into_any_element()
    }
}

impl Focusable for TerpApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerpApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        let font = cx.global::<Appearance>().font.clone();
        let error = cx.global::<Appearance>().error.clone().or_else(|| self.notice.clone());
        let root = self.layout().map(|l| l.root.clone()).unwrap_or(Node::Leaf(1));
        if !self.layouts.contains_key(&self.workspace()) {
            self.layout_mut();
        }
        let panes = self.render_node(&root, Vec::new(), &p, window, cx);

        div()
            .key_context("Terp")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_row()
            .font_family(font.family.clone())
            .text_color(p.text)
            .on_mouse_move(cx.listener(Self::on_drag_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_drag_end))
            .on_action(cx.listener(Self::new_terminal))
            .on_action(cx.listener(Self::split_right))
            .on_action(cx.listener(Self::close_tab))
            .on_action(cx.listener(Self::recent_tab))
            .on_action(cx.listener(Self::next_attention))
            .on_action(cx.listener(Self::open_config))
            .on_action(cx.listener(|app, _: &NextTab, w, cx| app.cycle_tab(1, w, cx)))
            .on_action(cx.listener(|app, _: &PrevTab, w, cx| app.cycle_tab(-1, w, cx)))
            .on_action(cx.listener(|app, _: &PaneLeft, w, cx| app.focus_neighbor(Direction::Left, w, cx)))
            .on_action(cx.listener(|app, _: &PaneRight, w, cx| app.focus_neighbor(Direction::Right, w, cx)))
            .on_action(cx.listener(|app, _: &PaneUp, w, cx| app.focus_neighbor(Direction::Up, w, cx)))
            .on_action(cx.listener(|app, _: &PaneDown, w, cx| app.focus_neighbor(Direction::Down, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab1, w, cx| app.select_index(0, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab2, w, cx| app.select_index(1, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab3, w, cx| app.select_index(2, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab4, w, cx| app.select_index(3, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab5, w, cx| app.select_index(4, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab6, w, cx| app.select_index(5, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab7, w, cx| app.select_index(6, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab8, w, cx| app.select_index(7, w, cx)))
            .on_action(cx.listener(|app, _: &SelectTab9, w, cx| app.select_index(8, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace1, w, cx| app.workspace_index(0, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace2, w, cx| app.workspace_index(1, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace3, w, cx| app.workspace_index(2, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace4, w, cx| app.workspace_index(3, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace5, w, cx| app.workspace_index(4, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace6, w, cx| app.workspace_index(5, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace7, w, cx| app.workspace_index(6, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace8, w, cx| app.workspace_index(7, w, cx)))
            .on_action(cx.listener(|app, _: &Workspace9, w, cx| app.workspace_index(8, w, cx)))
            .on_action(cx.listener(|app, _: &WorkspaceNext, w, cx| app.cycle_workspace(1, w, cx)))
            .on_action(cx.listener(|app, _: &WorkspacePrev, w, cx| app.cycle_workspace(-1, w, cx)))
            .on_action(cx.listener(|app, _: &ToggleSidebar, _, cx| {
                app.sidebar = !app.sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|app, _: &FontBigger, w, cx| app.set_font_delta(app.font_delta + 1.0, w, cx)))
            .on_action(cx.listener(|app, _: &FontSmaller, w, cx| app.set_font_delta(app.font_delta - 1.0, w, cx)))
            .on_action(cx.listener(|app, _: &FontReset, w, cx| app.set_font_delta(0.0, w, cx)))
            .when(self.sidebar, |d| d.child(self.render_sidebar(&p, cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(div().flex_1().min_h_0().flex().child(panes))
                    .when_some(error, |d, error| {
                        d.child(div().flex_none().px_3().py_1().text_xs().bg(p.active).text_color(p.warning).child(error))
                    }),
            )
    }
}
