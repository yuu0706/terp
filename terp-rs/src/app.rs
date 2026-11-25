// 窓の中身。左の一覧・枠ごとのタブ・ワークスペースと、エージェントの状態の知らせを持つ。
use crate::agent::{AgentState, clean};
use crate::appearance::{Appearance, hsla};
use crate::config::{Config, config_path, home_dir};
use crate::panes::{Axis, Direction, Layout, Node, Side, drop_side};
use crate::projects::{self, Project, Projects, contains_path};
use crate::input::{InputEvent, TextInput};
use crate::ptyhost::SessionSummary;
use crate::state::{ClosedTab, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, UiState};
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
        ReopenClosed,
        RenameTab,
        ToggleOverview,
        RecentTabBack,
        NewWork,
        AddRepository,
        FontBigger,
        FontSmaller,
        FontReset,
        OpenConfig,
        OpenSettings,
    ]
);

const TAB_BAR_HEIGHT: f32 = 38.0;
const DIVIDER: f32 = 4.0;
// 信号機のボタン（閉じる・しまう・広げる）を避ける幅
const TRAFFIC_LIGHT_SPACE: f32 = 78.0;
const NOTIFY_INTERVAL: Duration = Duration::from_secs(3);

pub(crate) struct Session {
    pub(crate) id: u64,
    pub(crate) view: Entity<TerminalView>,
    pub(crate) workspace: String,
    last_notify: Option<Instant>,
    _subscriptions: [Subscription; 2],
}

// ドラッグしているタブ。落とした枠の端なら分割し、真ん中ならその枠のタブにする
#[derive(Clone)]
pub struct DraggedTab {
    pub(crate) id: u64,
    label: String,
}

impl DraggedTab {
    pub(crate) fn new(id: u64, label: String) -> Self {
        DraggedTab { id, label }
    }
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

struct Rename {
    id: u64,
    input: Entity<TextInput>,
    _subscription: Subscription,
}

struct DividerDrag {
    workspace: String,
    path: Vec<usize>,
    index: usize,
    axis: Axis,
    last: Point<Pixels>,
}

pub struct TerpApp {
    pub(crate) focus: FocusHandle,
    pub(crate) sessions: Vec<Session>,
    pub(crate) next_id: u64,
    pub(crate) layouts: HashMap<String, Layout>,
    pub(crate) recent: Vec<u64>,
    pub(crate) projects: Projects,
    pub(crate) sidebar: bool,
    pub(crate) sidebar_width: f32,
    pub(crate) sidebar_drag: Option<(f32, f32)>,
    pub(crate) font_delta: f32,
    pub(crate) ui: UiState,
    pub(crate) saved_ui: Option<UiState>,
    pub(crate) rename: Option<Rename>,
    pub(crate) config_mtime: Option<SystemTime>,
    pub(crate) notice: Option<String>,
    pub(crate) dock_count: usize,
    pub(crate) drag: Option<DividerDrag>,
    pub(crate) split_bounds: Rc<RefCell<HashMap<Vec<usize>, Bounds<Pixels>>>>,
    pub(crate) pane_bounds: HashMap<u64, Bounds<Pixels>>,
    pub(crate) drop_hint: Option<(u64, Side)>,
    pub(crate) host: Option<Arc<HostClient>>,
    pub(crate) menu: Option<crate::overlay::Menu>,
    pub(crate) repos: HashMap<String, Vec<crate::git::Worktree>>,
    pub(crate) repos_loading: bool,
    pub(crate) agents: Vec<crate::agents::Agent>,
    pub(crate) overview: Option<crate::overview::Overview>,
    pub(crate) overview_tab_memory: Option<String>,
    pub(crate) settings: Option<crate::settings::Settings>,
    pub(crate) poll_count: u64,
    pub(crate) intel_running: bool,
    pub(crate) expanded_subagents: std::collections::HashSet<u64>,
    // シェルの pid ごとの claude の会話（15秒使い回す）
    pub(crate) claude_cache: Option<(Instant, HashMap<i32, (String, Option<PathBuf>)>)>,
    pub(crate) dialog: Option<crate::overlay::Dialog>,
    pub(crate) _poll: Task<()>,
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
pub(crate) struct Palette {
    pub(crate) bg: Hsla,
    pub(crate) term_bg: Hsla,
    pub(crate) hover: Hsla,
    pub(crate) active: Hsla,
    pub(crate) border: Hsla,
    pub(crate) text: Hsla,
    pub(crate) muted: Hsla,
    pub(crate) accent: Hsla,
    pub(crate) accent_fill: Hsla,
    pub(crate) accent_fill_dim: Hsla,
    pub(crate) accent_fill_work: Hsla,
    pub(crate) card: Hsla,
    pub(crate) busy: Hsla,
    pub(crate) warning: Hsla,
    pub(crate) success: Hsla,
    pub(crate) info: Hsla,
    pub(crate) danger: Hsla,
    pub(crate) solid_bg: Hsla,
    pub(crate) on_accent: Hsla,
}

fn text_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

fn show_notification(id: u64, title: String, body: String, cx: &mut App) {
    cx.show_system_notification(SystemNotification { tag: format!("terp-{id}").into(), title: title.into(), body: body.into(), actions: Vec::new() });
}

pub(crate) fn palette(cx: &App) -> Palette {
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
        accent_fill_work: hsla(c.bg.mix(c.accent, c.accent_fill * 12.0 / 22.0), 1.0),
        card: hsla(c.bg_hover, 0.45),
        busy: hsla(c.accent, 1.0),
        warning: hsla(a.theme.palette[3], 1.0),
        success: hsla(a.theme.palette[2], 1.0),
        info: hsla(a.theme.palette[4], 1.0),
        danger: hsla(a.theme.palette[1], 1.0),
        solid_bg: hsla(c.bg, 1.0),
        on_accent: hsla(crate::config::readable_on(c.accent, &[crate::config::BLACK, crate::config::WHITE]), 1.0),
    }
}

// 端末の印。エージェントは 考え中（強調色の輪）・許可待ち（黄の「!」）・終わった（緑）、
// シェルは 出力中（緑）・裏で出力があった（青）・通知あり（黄）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mark {
    Agent(AgentState),
    Output,
    Unread,
    Bell,
    None,
}

pub(crate) fn mark_of(view: &TerminalView) -> Mark {
    if view.is_agent() {
        return match view.agent_state() {
            AgentState::Idle if view.unseen_bell => Mark::Bell,
            state => Mark::Agent(state),
        };
    }
    if view.unseen_bell {
        Mark::Bell
    } else if view.outputting() {
        Mark::Output
    } else if view.unread {
        Mark::Unread
    } else {
        Mark::None
    }
}

pub(crate) fn mark_dot(mark: Mark, p: &Palette) -> Option<AnyElement> {
    let (color, text) = match mark {
        Mark::Agent(AgentState::Working) => {
            return Some(div().flex_none().size(px(9.0)).rounded_full().border_2().border_color(p.accent).into_any_element());
        }
        Mark::Agent(AgentState::Waiting) => (p.warning, "!"),
        Mark::Agent(AgentState::Done) => (p.success, ""),
        Mark::Agent(AgentState::Idle) => {
            return Some(div().flex_none().size(px(7.0)).rounded_full().border_1().border_color(p.muted).into_any_element());
        }
        Mark::Output => (p.success, ""),
        Mark::Unread => (p.info, ""),
        Mark::Bell => (p.warning, ""),
        Mark::None => return None,
    };
    let mark = text;
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
        let ui = UiState::load();
        load_appearance(ui.font_delta as f32, cx);
        let mut app = TerpApp {
            focus: cx.focus_handle(),
            sessions: Vec::new(),
            next_id: 1,
            layouts: HashMap::new(),
            recent: Vec::new(),
            projects: Projects::load(),
            sidebar: !ui.sidebar_hidden,
            sidebar_width: ui.sidebar_width,
            sidebar_drag: None,
            font_delta: ui.font_delta as f32,
            saved_ui: Some(ui.clone()),
            ui,
            rename: None,
            config_mtime: mtime(&config_path()),
            notice: None,
            dock_count: 0,
            drag: None,
            split_bounds: Rc::default(),
            pane_bounds: HashMap::new(),
            drop_hint: None,
            host: None,
            menu: None,
            dialog: None,
            repos: HashMap::new(),
            repos_loading: false,
            agents: Vec::new(),
            overview: None,
            overview_tab_memory: None,
            settings: None,
            poll_count: 0,
            intel_running: false,
            expanded_subagents: Default::default(),
            claude_cache: None,
            _poll: poll,
        };
        match HostClient::connect() {
            Ok((host, sessions)) => {
                app.host = Some(host);
                if sessions.is_empty() {
                    app.restore_from_snapshot(window, cx);
                } else {
                    app.restore_sessions(sessions, window, cx);
                }
            }
            Err(err) => {
                app.notice = Some(format!("終了後もシェルを残す常駐のプロセスを使えない（{err}）。この窓を閉じるとシェルも終わる"));
            }
        }
        match app.active_id() {
            Some(id) => app.select(id, window, cx),
            None => app.open_terminal(home_dir(), window, cx),
        }
        app.refresh_repos(cx);
        app.refresh_agents(cx);
        // 窓に戻ったら、リポジトリとエージェントを探し直す
        cx.observe_window_activation(window, |app, window, cx| {
            if window.is_window_active() {
                app.refresh_repos(cx);
                app.refresh_agents(cx);
            }
        })
        .detach();
        app
    }

    pub(crate) fn workspace(&self) -> String {
        self.projects.active_workspace.clone()
    }

    pub(crate) fn layout(&self) -> Option<&Layout> {
        self.layouts.get(&self.workspace())
    }

    pub(crate) fn layout_mut(&mut self) -> &mut Layout {
        let ws = self.workspace();
        self.layouts.entry(ws).or_default()
    }

    pub(crate) fn session(&self, id: u64) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub(crate) fn active_id(&self) -> Option<u64> {
        self.layout().and_then(|l| l.active_tab()).filter(|id| self.session(*id).is_some())
    }

    pub(crate) fn workspace_ids(&self, workspace: &str) -> Vec<u64> {
        self.sessions.iter().filter(|s| s.workspace == workspace).map(|s| s.id).collect()
    }

    pub(crate) fn is_visible(&self, id: u64) -> bool {
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
        self.persist(cx);
        self.poll_count += 1;
        if self.poll_count % 5 == 0 {
            self.refresh_repos(cx);
        }
        if self.poll_count % 3 == 0 {
            self.refresh_intel(cx);
        }
        if self.poll_count % 10 == 0 {
            self.write_snapshot(cx);
        }
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

    pub(crate) fn spawn_session(&mut self, cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Option<u64> {
        let workspace = self.workspace();
        self.spawn_session_in(cwd, workspace, window, cx)
    }

    fn spawn_session_in(&mut self, cwd: PathBuf, workspace: String, window: &mut Window, cx: &mut Context<Self>) -> Option<u64> {
        let cwd = if cwd.is_dir() { cwd } else { home_dir() };
        let size = GridSize { cols: 80, rows: 24 };
        let meta = serde_json::json!({ "workspace": workspace });
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
        Some(self.add_session(view, workspace, window, cx))
    }

    // 常駐のプロセスごと消えていたら、控えから同じ場所・名前・所属で開き直し、エージェントの会話を再開する
    fn restore_from_snapshot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let saved = crate::snapshot::load();
        if saved.is_empty() {
            return;
        }
        let configured = cx.global::<Appearance>().config.agents.clone();
        let agents = crate::agents::detect(&configured, "");
        let mut to_app: HashMap<u64, u64> = HashMap::new();
        for s in saved {
            let workspace = Some(s.workspace.clone())
                .filter(|w| self.projects.workspaces.iter().any(|x| x.id == *w))
                .unwrap_or_else(|| self.workspace());
            let Some(id) = self.spawn_session_in(s.cwd.clone(), workspace.clone(), window, cx) else { continue };
            if let Some(old) = s.id {
                to_app.insert(old, id);
            }
            let line = crate::snapshot::resume_line(&s, &agents);
            if let Some(session) = self.session(id) {
                session.view.update(cx, |v, _| {
                    v.custom_name = s.custom_name.clone();
                    v.work_path = s.work_path.clone();
                    v.bypass = s.bypass && line.is_some();
                    v.save_meta(&workspace);
                    if let Some(line) = &line {
                        v.terminal.write(format!("{line}\r").as_bytes());
                    }
                });
            }
        }
        for (workspace, saved) in self.ui.layouts.clone() {
            let mapped = saved.map_tabs(|t| to_app.get(&t).copied());
            if !mapped.all_tabs().is_empty() {
                self.layouts.insert(workspace, mapped);
            }
        }
        let placed: Vec<u64> = self.layouts.values().flat_map(|l| l.all_tabs()).collect();
        for s in &self.sessions {
            if !placed.contains(&s.id) {
                self.layouts.entry(s.workspace.clone()).or_default().add_tab(s.id);
            }
        }
    }

    // 開き直すための控えと、会話の履歴を書く
    fn write_snapshot(&mut self, cx: &App) {
        let saved: Vec<crate::snapshot::Saved> = self
            .sessions
            .iter()
            .map(|s| {
                let v = s.view.read(cx);
                let program = v.process.as_ref().map(|p| p.name.clone()).unwrap_or_default();
                let agent = (v.is_agent() && (program == "claude" || program == "codex")).then(|| program.clone());
                let (session_id, config_dir) = match (&v.agent_session, agent.as_deref()) {
                    (Some(a), Some("claude")) => (a.id.clone(), a.config_dir.clone()),
                    (Some(a), Some("codex")) => (a.file.as_deref().and_then(crate::snapshot::codex_id), None),
                    _ => (None, None),
                };
                crate::snapshot::Saved {
                    id: v.terminal.remote_id(),
                    cwd: v.cwd(),
                    workspace: s.workspace.clone(),
                    custom_name: v.custom_name.clone(),
                    agent_title: v.agent_title.clone(),
                    work_path: v.work_path.clone(),
                    agent: agent.filter(|_| session_id.is_some()),
                    agent_session: session_id,
                    config_dir,
                    bypass: v.bypass,
                }
            })
            .collect();
        if let Err(err) = crate::snapshot::save(&saved) {
            self.notice = Some(format!("開き直すための控えを書けない: {err}"));
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let _ = crate::snapshot::record_history(&saved, now);
    }

    fn add_session(&mut self, view: Entity<TerminalView>, workspace: String, window: &mut Window, cx: &mut Context<Self>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let events = cx.subscribe_in(&view, window, move |app, _, event, window, cx| match event {
            TerminalEvent::Exited => app.close(id, false, window, cx),
            TerminalEvent::Changed => cx.notify(),
            TerminalEvent::Attention { kind, message } => app.on_attention(id, *kind, message.clone(), window, cx),
            TerminalEvent::OpenLink(target) => app.open_link(id, target.clone(), cx),
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
        let mut restored = Vec::new();
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
            let name = summary.meta.get("name").and_then(|n| n.as_str()).map(String::from);
            let work_path = summary.meta.get("workPath").and_then(|n| n.as_str()).map(PathBuf::from);
            let bypass = summary.meta.get("bypass").and_then(|n| n.as_bool()).unwrap_or(false);
            view.update(cx, |view, _| {
                view.custom_name = name;
                view.work_path = work_path;
                view.bypass = bypass;
            });
            let id = self.add_session(view, workspace.clone(), window, cx);
            restored.push((summary.id, id, workspace));
        }
        // 前の枠の配置に戻し、配置に無い端末は所属のワークスペースの今の枠に足す
        let to_app: HashMap<u64, u64> = restored.iter().map(|(host, app, _)| (*host, *app)).collect();
        for (workspace, saved) in self.ui.layouts.clone() {
            if !self.projects.workspaces.iter().any(|w| w.id == workspace) {
                continue;
            }
            let mapped = saved.map_tabs(|t| to_app.get(&t).copied());
            if !mapped.all_tabs().is_empty() {
                self.layouts.insert(workspace, mapped);
            }
        }
        for (_, id, workspace) in restored {
            let layout = self.layouts.entry(workspace).or_default();
            if !layout.all_tabs().contains(&id) {
                layout.add_tab(id);
            }
        }
    }

    // 画面の控えを今の状態にし、変わっていれば書く
    pub(crate) fn persist(&mut self, cx: &App) {
        let to_host: HashMap<u64, u64> =
            self.sessions.iter().filter_map(|s| s.view.read(cx).terminal.remote_id().map(|h| (s.id, h))).collect();
        self.ui.font_delta = self.font_delta as i32;
        self.ui.sidebar_hidden = !self.sidebar;
        self.ui.sidebar_width = self.sidebar_width;
        self.ui.layouts = self
            .layouts
            .iter()
            .map(|(ws, l)| (ws.clone(), l.map_tabs(|t| to_host.get(&t).copied())))
            .filter(|(_, l)| !l.all_tabs().is_empty())
            .collect();
        if self.saved_ui.as_ref() != Some(&self.ui) {
            match self.ui.save() {
                Ok(()) => self.saved_ui = Some(self.ui.clone()),
                Err(err) => self.notice = Some(format!("画面の控えを書けない: {err}")),
            }
        }
    }

    fn reopen_closed(&mut self, _: &ReopenClosed, window: &mut Window, cx: &mut Context<Self>) {
        if self.ui.closed.is_empty() {
            return;
        }
        let tab = self.ui.closed.remove(0);
        if tab.workspace != self.workspace() && self.projects.workspaces.iter().any(|w| w.id == tab.workspace) {
            self.set_workspace(&tab.workspace, window, cx);
        }
        if let Some(id) = self.spawn_session(tab.cwd, window, cx) {
            if tab.name.is_some() {
                self.set_name(id, tab.name, cx);
            }
            self.layout_mut().add_tab(id);
            self.select(id, window, cx);
        }
    }

    pub(crate) fn set_name(&mut self, id: u64, name: Option<String>, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let workspace = session.workspace.clone();
        let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        session.view.update(cx, |view, cx| {
            view.custom_name = name.clone();
            view.save_meta(&workspace);
            cx.notify();
        });
        cx.notify();
    }

    pub(crate) fn start_rename(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let current = session.view.read(cx).custom_name.clone().unwrap_or_else(|| session.view.read(cx).display_name());
        let input = cx.new(|cx| {
            let mut input = TextInput::new("名前（空にすると自動の名前に戻す）", cx);
            input.set_text(&current, cx);
            input.select_all_text(cx);
            input
        });
        let subscription = cx.subscribe_in(&input, window, move |app, input, event, window, cx| match event {
            InputEvent::Submit { .. } => {
                let text = input.read(cx).text().to_string();
                app.rename = None;
                app.set_name(id, Some(text), cx);
                app.select(id, window, cx);
            }
            InputEvent::Cancel => {
                app.rename = None;
                app.select(id, window, cx);
            }
            _ => {}
        });
        window.focus(&input.focus_handle(cx), cx);
        self.rename = Some(Rename { id, input, _subscription: subscription });
        cx.notify();
    }

    fn rename_active(&mut self, _: &RenameTab, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.active_id() {
            self.start_rename(id, window, cx);
        }
    }

    // 名前の欄。名前を変えている端末なら入力欄を、そうでなければ名前を出す
    pub(crate) fn name_label(&self, id: u64, name: String) -> AnyElement {
        match self.rename.as_ref().filter(|r| r.id == id) {
            Some(r) => div().flex_1().min_w(px(80.0)).child(r.input.clone()).into_any_element(),
            None => div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(name).into_any_element(),
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

    pub(crate) fn select(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let workspace = session.workspace.clone();
        let view = session.view.clone();
        if workspace != self.workspace() {
            self.set_workspace(&workspace, window, cx);
        }
        let previous = self.active_id();
        // 枠のタブに無い端末は、操作中の枠のタブに足して出す
        if !self.layout_mut().select(id) {
            self.layout_mut().add_tab(id);
        }
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

    // 枠のタブから外すだけ。端末は左の一覧に残る（終わらせるのは一覧の行の ×）
    pub(crate) fn hide_tab(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.session(id).map(|s| s.workspace.clone()) else { return };
        let was_active = self.active_id() == Some(id);
        let recent = self.recent.clone();
        if let Some(layout) = self.layouts.get_mut(&workspace) {
            layout.remove_tab(id, &recent);
        }
        if was_active {
            match self.active_id() {
                Some(next) => self.select(next, window, cx),
                None => window.focus(&self.focus, cx),
            }
        }
        cx.notify();
    }

    // remember なら ⇧⌘T で開き直せるよう覚える（シェルの exit で終わった端末は覚えない）
    pub(crate) fn close(&mut self, id: u64, remember: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.session(id).map(|s| s.workspace.clone()) else { return };
        if remember && let Some(session) = self.session(id) {
            let view = session.view.read(cx);
            self.ui.push_closed(ClosedTab { cwd: view.cwd(), name: view.custom_name.clone(), workspace: workspace.clone() });
        }
        if self.rename.as_ref().is_some_and(|r| r.id == id) {
            self.rename = None;
        }
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
            let (title, body, record) = {
                let view = view.read(cx);
                // 題の場所は「リポジトリ / ブランチ」、作業の外は ~ 起点の場所
                let place = match self.placement(id, cx) {
                    Some((repo, work)) => {
                        let name = Path::new(&repo).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(repo.clone());
                        let branch = self.repos.get(&repo).and_then(|l| l.iter().find(|w| w.path == work)).map(|w| w.label());
                        match branch {
                            Some(b) => format!("{name} / {b}"),
                            None => name,
                        }
                    }
                    None => short_path(&view.cwd()),
                };
                let text = Some(clean(&message)).filter(|m| !m.is_empty()).unwrap_or_else(|| {
                    match kind {
                        Attention::Done => "応答が終わった",
                        Attention::Bell => "ベルが鳴った",
                    }
                    .to_string()
                });
                let record = (kind == Attention::Done && config.notify_message)
                    .then(|| view.agent_session.as_ref().and_then(|s| s.file.clone().map(|f| (f, s.kind))))
                    .flatten();
                (format!("{} · {place}", clean(&view.display_name())), text.chars().take(200).collect::<String>(), record)
            };
            if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                session.last_notify = Some(Instant::now());
            }
            match record {
                // 返答の文を本文にする。記録に書き終わるのを最大2秒待つ
                Some((file, kind)) => {
                    let previous = view.read(cx).last_reply;
                    cx.spawn(async move |this, cx| {
                        let mut reply = String::new();
                        for _ in 0..8 {
                            let (f, k) = (file.clone(), kind);
                            let text = cx.background_executor().spawn(async move { crate::transcript::read_reply(&f, k) }).await;
                            let hash = text_hash(&text);
                            if !text.trim().is_empty() && Some(hash) != previous {
                                reply = text;
                                break;
                            }
                            cx.background_executor().timer(Duration::from_millis(250)).await;
                        }
                        let _ = this.update(cx, |app, cx| {
                            let body = if reply.is_empty() { body } else { crate::transcript::format_reply(&reply) };
                            if !reply.is_empty()
                                && let Some(s) = app.session(id)
                            {
                                s.view.update(cx, |v, _| v.last_reply = Some(text_hash(&reply)));
                            }
                            show_notification(id, title, body, cx);
                        });
                    })
                    .detach();
                }
                None => show_notification(id, title, body, cx),
            }
        }
        self.update_dock(cx);
        cx.notify();
    }

    // エージェントの会話の記録から、今していること・編集したファイル・サブエージェントを読み直す
    fn refresh_intel(&mut self, cx: &mut Context<Self>) {
        if self.intel_running {
            return;
        }
        let targets: Vec<(u64, i32, String)> = self
            .sessions
            .iter()
            .filter_map(|s| {
                let v = s.view.read(cx);
                let p = v.process.as_ref()?;
                let shell = p.shell_pid?;
                (v.is_agent() && (p.name == "claude" || p.name == "codex")).then(|| (s.id, shell, p.name.clone()))
            })
            .collect();
        if targets.is_empty() {
            return;
        }
        let cached = self.claude_cache.clone().filter(|(at, _)| at.elapsed() < Duration::from_secs(15)).map(|(_, m)| m);
        self.intel_running = true;
        cx.spawn(async move |this, cx| {
            let (found, sessions) = cx
                .background_executor()
                .spawn(async move {
                    use crate::transcript::{self as t, Kind};
                    let procs = t::procs();
                    let shells: std::collections::HashSet<i32> = targets.iter().filter(|x| x.2 == "claude").map(|x| x.1).collect();
                    let sessions = cached.unwrap_or_else(|| t::claude_sessions(&shells, &procs));
                    let mut found = Vec::new();
                    for (id, shell, name) in targets {
                        let session = if name == "claude" {
                            sessions.get(&shell).map(|(sid, dir)| t::Session {
                                kind: Kind::Claude,
                                id: Some(sid.clone()),
                                config_dir: dir.clone(),
                                file: t::claude_file(sid, dir.as_deref()),
                            })
                        } else {
                            t::codex_file(shell, &procs).map(|f| t::Session { kind: Kind::Codex, id: None, config_dir: None, file: Some(f) })
                        };
                        let activity = session.as_ref().and_then(|s| s.file.as_ref()).map(|f| t::activity_of(&t::tail_rows(f, t::TAIL_BYTES).0, session.as_ref().unwrap().kind));
                        let subagents = session
                            .as_ref()
                            .filter(|s| s.kind == Kind::Claude)
                            .and_then(|s| s.id.as_ref().map(|id| t::subagents(id, s.config_dir.as_deref())))
                            .unwrap_or_default();
                        found.push((id, session, activity, subagents));
                    }
                    (found, sessions)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.intel_running = false;
                if app.claude_cache.as_ref().is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(15)) {
                    app.claude_cache = Some((Instant::now(), sessions));
                }
                for (id, session, activity, subagents) in found {
                    if let Some(s) = app.session(id) {
                        s.view.update(cx, |v, _| {
                            v.agent_session = session;
                            v.activity = activity.as_ref().map(|a| a.text.clone()).filter(|t| !t.is_empty());
                            v.edits = activity.map(|a| a.edits).unwrap_or_default();
                            v.subagents = subagents;
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // 30分以内に、別の端末のエージェントも同じファイルを書き換えたか。（ファイル名, 相手の名前）
    pub(crate) fn clash(&self, id: u64, cx: &App) -> Option<(String, Vec<String>)> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let recent = |edits: &Vec<(PathBuf, i64)>| -> Vec<PathBuf> { edits.iter().filter(|(_, at)| now - at < 1800).map(|(p, _)| p.clone()).collect() };
        let mine = recent(&self.session(id)?.view.read(cx).edits);
        for file in &mine {
            let others: Vec<String> = self
                .sessions
                .iter()
                .filter(|s| s.id != id)
                .filter(|s| recent(&s.view.read(cx).edits).contains(file))
                .map(|s| s.view.read(cx).display_name())
                .collect();
            if !others.is_empty() {
                return Some((file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), others));
            }
        }
        None
    }

    pub(crate) fn refresh_agents(&mut self, cx: &mut Context<Self>) {
        let configured = cx.global::<Appearance>().config.agents.clone();
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move {
                    let path = crate::git::login_env().get("PATH").cloned().unwrap_or_default();
                    crate::agents::detect(&configured, &path)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.agents != found {
                    app.agents = found;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    // 見つかって、隠していないエージェント
    pub(crate) fn found_agents(&self) -> Vec<crate::agents::Agent> {
        self.agents.iter().filter(|a| a.found() && !a.hidden).cloned().collect()
    }

    pub(crate) fn skip_approvals(&self, cx: &App) -> bool {
        cx.global::<Appearance>().config.skip_approvals
    }

    // 新しい端末を開き、エージェントを起動する1行を打つ。シェルは起動前の入力をためておくため、すぐ送ってよい
    pub(crate) fn launch_agent_at(&mut self, agent: &crate::agents::Agent, bypass: bool, cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let bypass = bypass && !agent.bypass_args.is_empty();
        let line = crate::agents::command_line(agent, bypass);
        self.run_in_new_terminal(cwd, line, bypass, window, cx);
    }

    pub(crate) fn run_in_new_terminal(&mut self, cwd: PathBuf, line: String, bypass: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.spawn_session(cwd, window, cx) else { return };
        self.layout_mut().add_tab(id);
        self.select(id, window, cx);
        if let Some(session) = self.session(id) {
            let workspace = session.workspace.clone();
            session.view.update(cx, |view, cx| {
                view.bypass = bypass;
                view.save_meta(&workspace);
                view.terminal.write(format!("{line}\r").as_bytes());
                cx.notify();
            });
        }
    }

    // URL は既定のブラウザ、ファイルは外部のエディタ、フォルダは Finder で開く
    fn open_link(&mut self, id: u64, target: crate::links::Target, cx: &mut Context<Self>) {
        if let crate::links::Target::Url(url) = &target {
            cx.open_url(url);
            return;
        }
        let Some(session) = self.session(id) else { return };
        let cwd = session.view.read(cx).cwd();
        let root = self.placement(id, cx).map(|(_, w)| w);
        match crate::links::resolve(&target, &cwd, root.as_deref(), &home_dir()) {
            Some(r) if r.directory => cx.open_with_system(&r.path),
            Some(r) => {
                let editor = cx.global::<Appearance>().config.editor.clone();
                let path = crate::git::login_env().get("PATH").cloned().unwrap_or_default();
                crate::links::open_file(&r, &editor, &path);
            }
            None => {
                self.notice = Some("リンクのファイルが見つからない".into());
                cx.notify();
            }
        }
    }

    // メインのエージェント。設定の mainAgent、無ければ見つかった最初のもの
    pub(crate) fn main_agent(&self, cx: &App) -> Option<crate::agents::Agent> {
        let found = self.found_agents();
        let main = cx.global::<Appearance>().config.main_agent.clone();
        main.and_then(|m| found.iter().find(|a| a.command == m).cloned()).or_else(|| found.first().cloned())
    }

    // 新しいタブのプルダウン: ターミナル / 見つかったエージェント / 利用者のコマンド
    fn new_tab_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        use crate::overlay::{MenuItem, action};
        let mut items = vec![MenuItem::new("ターミナル", action(|app, window, cx| app.new_terminal(&NewTerminal, window, cx))).hint("⌘T")];
        let agents = self.found_agents();
        if !agents.is_empty() {
            items.push(MenuItem::separator());
            let skip = self.skip_approvals(cx);
            for agent in agents {
                let a = agent.clone();
                let hint = if agent.bypass_args.is_empty() { String::new() } else if skip { "確認なし".into() } else { String::new() };
                let mut item = MenuItem::new(
                    agent.label.clone(),
                    action(move |app, window, cx| {
                        let bypass = app.skip_approvals(cx) != window.modifiers().alt;
                        let place = app.new_terminal_place(cx);
                        app.launch_agent_at(&a, bypass, place, window, cx);
                    }),
                );
                if !hint.is_empty() {
                    item = item.hint(hint);
                }
                items.push(item);
            }
        }
        items.push(MenuItem::separator());
        let commands = crate::agents::user_commands(&cx.global::<Appearance>().config.commands);
        for command in &commands {
            let line = command.command.clone();
            items.push(MenuItem::new(
                command.label.clone(),
                action(move |app, window, cx| {
                    let place = app.new_terminal_place(cx);
                    app.run_in_new_terminal(place, line.clone(), false, window, cx);
                }),
            ));
        }
        items.push(MenuItem::new(
            if commands.is_empty() { "コマンドを登録" } else { "コマンドを編集" },
            action(|app, window, cx| app.open_settings(window, cx)),
        ));
        self.open_menu(position, items, cx);
    }

    pub(crate) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_settings_screen(window, cx);
    }

    // 操作中の端末へ入力を戻す
    pub(crate) fn refocus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.active_id().and_then(|a| self.session(a)).map(|s| s.view.clone()) {
            Some(view) => view.update(cx, |view, cx| view.focus(window, cx)),
            None => window.focus(&self.focus, cx),
        }
    }

    pub(crate) fn set_workspace(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(crate) fn new_terminal(&mut self, _: &NewTerminal, window: &mut Window, cx: &mut Context<Self>) {
        // 表示中のタブの作業の一番上、作業の外ならホームで開く
        let cwd = self.new_terminal_place(cx);
        self.open_terminal(cwd, window, cx);
    }

    fn close_tab(&mut self, _: &CloseTab, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.active_id() {
            self.hide_tab(id, window, cx);
        } else {
            window.remove_window();
        }
    }

    fn recent_tab(&mut self, _: &RecentTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.overview.is_some() {
            self.cycle_overview_tab(1, cx);
            return;
        }
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

    fn set_font_delta(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        let base = cx.global::<Appearance>().config.font_size;
        self.font_delta = delta.clamp(6.0 - base, 40.0 - base).round();
        self.reload_appearance(window, cx);
    }

    pub(crate) fn open_config(&mut self, _: &OpenConfig, _window: &mut Window, cx: &mut Context<Self>) {
        let path = config_path();
        if !path.exists() {
            let _ = std::fs::create_dir_all(crate::config::config_dir());
            let _ = std::fs::write(&path, "{}\n");
        }
        cx.open_with_system(&path);
    }

    fn on_drag_move(&mut self, event: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some((start, width)) = self.sidebar_drag {
            if event.pressed_button != Some(MouseButton::Left) {
                self.sidebar_drag = None;
            } else {
                self.sidebar_width = (width + f32::from(event.position.x) - start).clamp(SIDEBAR_MIN, SIDEBAR_MAX).round();
            }
            cx.notify();
            return;
        }
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
        if self.drag.take().is_some() || self.drop_hint.take().is_some() || self.sidebar_drag.take().is_some() {
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
            bar = bar.pl(px(TRAFFIC_LIGHT_SPACE)).child(
                crate::ui::icon_button("sidebar-show", "sidebar", "左の一覧を出す（⌘B）", p.muted, p.hover, p.text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                        app.sidebar = true;
                        cx.notify();
                    })),
            );
        }
        for (index, id) in pane.tabs.iter().copied().enumerate() {
            let Some(session) = self.session(id) else { continue };
            let view = session.view.read(cx);
            let selected = pane.active == Some(id);
            let label = format!("{}  {}", index + 1, view.display_name());
            let name = self.name_label(id, label);
            let state = view.agent_state();
            let dot = mark_dot(mark_of(view), p);
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
                    .on_mouse_down(MouseButton::Middle, cx.listener(move |app, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        app.hide_tab(id, window, cx);
                    }))
                    .on_click(cx.listener(move |app, event: &ClickEvent, window, cx| {
                        if event.click_count() == 2 {
                            app.start_rename(id, window, cx);
                        } else {
                            app.select(id, window, cx);
                        }
                    }))
                    .on_drag(DraggedTab { id, label: view.display_name() }, |tab, _, _, cx| cx.new(|_| tab.clone()))
                    .drag_over::<DraggedTab>(move |s, _, _, _| s.border_l_2().border_color(accent))
                    .on_drop(cx.listener(move |app, dragged: &DraggedTab, window, cx| {
                        cx.stop_propagation();
                        app.layout_mut().reorder(dragged.id, id);
                        app.select(dragged.id, window, cx);
                    }))
                    .when_some(dot, |d, dot| d.child(dot))
                    .child(name)
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
                                app.hide_tab(id, window, cx);
                            }))
                            .tooltip(|_, cx| crate::tooltip::text("タブを閉じる（⌘W）", cx))
                            .child("×"),
                    ),
            );
        }
        // 操作中の枠にだけ、新しいタブのプルダウンとメインのエージェントのボタンを出す
        let main_agent = self.main_agent(cx);
        let bar = bar
            .when(layout.active_pane == pane_id, |bar| {
                bar.child(
                    crate::ui::icon_button(("new-tab", pane_id), "plus", "新しいタブ", p.muted, p.hover, p.text)
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |app, event: &ClickEvent, _, cx| {
                            app.new_tab_menu(event.position(), cx);
                        })),
                )
                .when_some(main_agent, |bar, agent| {
                    let tip = format!("{} を起動（⌥ で{}）", agent.label, if self.skip_approvals(cx) { "確認あり" } else { "確認なし" });
                    let icon_name = agent.icon.clone();
                    bar.child(
                        div()
                            .id(("main-agent", pane_id))
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(24.0))
                            .rounded_md()
                            .hover(|s| s.bg(p.hover))
                            .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |app, event: &ClickEvent, window, cx| {
                                let bypass = app.skip_approvals(cx) != event.modifiers().alt;
                                let place = app.new_terminal_place(cx);
                                app.launch_agent_at(&agent, bypass, place, window, cx);
                            }))
                            .child(crate::ui::agent_icon(&icon_name, 15.0, p.muted)),
                    )
                })
            });

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
            .on_action(cx.listener(Self::reopen_closed))
            .on_action(cx.listener(|app, _: &OpenSettings, w, cx| app.open_settings(w, cx)))
            .on_action(cx.listener(|app, _: &ToggleOverview, w, cx| app.toggle_overview(w, cx)))
            .on_action(cx.listener(|app, _: &RecentTabBack, _, cx| app.cycle_overview_tab(-1, cx)))
            .on_action(cx.listener(|app, _: &NewWork, w, cx| app.new_work_dialog(None, w, cx)))
            .on_action(cx.listener(|app, _: &AddRepository, w, cx| app.prompt_add_repo(w, cx)))
            .on_action(cx.listener(Self::rename_active))
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
            .when(self.sidebar, |d| d.child(self.render_sidebar_frame(&p, cx)))
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
            .children(self.render_overview(&p, window, cx))
            .children(self.render_settings(&p, cx))
            .children(self.render_menu(&p, cx))
            .children(self.render_dialog(&p, cx))
    }
}
