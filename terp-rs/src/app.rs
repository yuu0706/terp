// 窓の中身。左の一覧・タブ・ワークスペースと、開いているターミナルの切り替えを持つ。
use crate::appearance::{Appearance, hsla};
use crate::config::{Config, config_path, home_dir};
use crate::projects::{self, Project, Projects, contains_path};
use crate::terminal_view::{TerminalEvent, TerminalView};
use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla, MouseButton, MouseDownEvent,
    Render, SharedString, Subscription, Task, Window, WindowBackgroundAppearance, actions, div, prelude::*, px,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

actions!(
    terp,
    [
        NewTerminal,
        CloseTab,
        NextTab,
        PrevTab,
        RecentTab,
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
// 信号機のボタン（閉じる・しまう・広げる）を避ける幅
const TRAFFIC_LIGHT_SPACE: f32 = 78.0;

struct Session {
    id: u64,
    view: Entity<TerminalView>,
    workspace: String,
    _subscription: Subscription,
}

pub struct TerpApp {
    focus: FocusHandle,
    sessions: Vec<Session>,
    next_id: u64,
    active: HashMap<String, u64>,
    recent: Vec<u64>,
    projects: Projects,
    sidebar: bool,
    font_delta: f32,
    config_mtime: Option<SystemTime>,
    notice: Option<String>,
    _poll: Task<()>,
}

pub fn load_appearance(font_delta: f32, cx: &mut App) {
    let (config, error) = Config::load(&config_path());
    let appearance = Appearance::build(config, error, font_delta, cx);
    cx.set_global(appearance);
}

pub fn background_appearance(cx: &App) -> WindowBackgroundAppearance {
    let config = &cx.global::<Appearance>().config;
    if config.background_opacity >= 1.0 {
        WindowBackgroundAppearance::Opaque
    } else if config.background_blur.enabled() {
        WindowBackgroundAppearance::Blurred
    } else {
        WindowBackgroundAppearance::Transparent
    }
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
        warning: hsla(a.theme.palette[3], 1.0),
    }
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
        let mut app = TerpApp {
            focus: cx.focus_handle(),
            sessions: Vec::new(),
            next_id: 1,
            active: HashMap::new(),
            recent: Vec::new(),
            projects: Projects::load(),
            sidebar: true,
            font_delta: 0.0,
            config_mtime: mtime(&config_path()),
            notice: None,
            _poll: poll,
        };
        app.open_terminal(home_dir(), window, cx);
        app
    }

    fn workspace(&self) -> String {
        self.projects.active_workspace.clone()
    }

    fn workspace_ids(&self) -> Vec<u64> {
        let ws = self.workspace();
        self.sessions.iter().filter(|s| s.workspace == ws).map(|s| s.id).collect()
    }

    fn session(&self, id: u64) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    fn active_id(&self) -> Option<u64> {
        self.active.get(&self.workspace()).copied().filter(|id| self.session(*id).is_some())
    }

    // 1秒ごとに、動いているプログラムと作業場所、設定ファイルとワークスペースの変更を確かめる
    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for session in &self.sessions {
            session.view.update(cx, |view, cx| view.refresh_process(cx));
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
            cx.notify();
        }
    }

    fn reload_appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        load_appearance(self.font_delta, cx);
        crate::bind_keys(cx);
        window.set_background_appearance(background_appearance(cx));
        cx.refresh_windows();
    }

    pub fn open_terminal(&mut self, cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let cwd = if cwd.is_dir() { cwd } else { home_dir() };
        let view = match TerminalView::spawn(&cwd, cx) {
            Ok(view) => view,
            Err(err) => {
                self.notice = Some(format!("ターミナルを開けない: {err}"));
                cx.notify();
                return;
            }
        };
        let id = self.next_id;
        self.next_id += 1;
        let subscription = cx.subscribe_in(&view, window, move |app, _, event, window, cx| match event {
            TerminalEvent::Exited => app.close(id, window, cx),
            TerminalEvent::Changed | TerminalEvent::Bell => cx.notify(),
        });
        self.sessions.push(Session { id, view, workspace: self.workspace(), _subscription: subscription });
        self.select(id, window, cx);
    }

    fn select(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let workspace = session.workspace.clone();
        let view = session.view.clone();
        if workspace != self.workspace() {
            self.set_workspace(&workspace, window, cx);
        }
        if let Some(previous) = self.active.insert(workspace, id)
            && previous != id
        {
            self.recent.retain(|r| *r != previous);
            self.recent.push(previous);
        }
        view.update(cx, |view, cx| {
            view.unseen_bell = false;
            view.focus(window, cx);
        });
        cx.notify();
    }

    fn close(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.workspace_ids();
        let position = ids.iter().position(|x| *x == id);
        let was_active = self.active_id() == Some(id);
        self.sessions.retain(|s| s.id != id);
        self.recent.retain(|r| *r != id);
        if was_active {
            let ws = self.workspace();
            self.active.remove(&ws);
            let remaining = self.workspace_ids();
            // 直前に見ていたタブがあればそこへ、無ければ隣のタブへ移る
            let next = self
                .recent
                .iter()
                .rev()
                .find(|r| remaining.contains(r))
                .copied()
                .or_else(|| position.and_then(|p| remaining.get(p.min(remaining.len().saturating_sub(1))).copied()));
            match next {
                Some(next) => self.select(next, window, cx),
                None => window.focus(&self.focus, cx),
            }
        }
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

    fn cycle_tab(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.workspace_ids();
        if ids.is_empty() {
            return;
        }
        let current = self.active_id().and_then(|a| ids.iter().position(|x| *x == a)).unwrap_or(0) as isize;
        let next = (current + step).rem_euclid(ids.len() as isize) as usize;
        self.select(ids[next], window, cx);
    }

    fn select_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.workspace_ids();
        // ⌘9 は最後のタブ
        let target = if index == 8 { ids.last() } else { ids.get(index) };
        if let Some(id) = target.copied() {
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
        let cwd = self.active_id().and_then(|id| self.session(id)).map(|s| s.view.read(cx).cwd()).unwrap_or_else(home_dir);
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
        let ids = self.workspace_ids();
        if let Some(id) = self.recent.iter().rev().find(|r| ids.contains(r) && Some(**r) != self.active_id()).copied() {
            self.select(id, window, cx);
        }
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

    fn render_tab_bar(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let active = self.active_id();
        let ids = self.workspace_ids();
        let mut bar = div()
            .id("tab-bar")
            .flex()
            .flex_row()
            .items_center()
            .h(px(TAB_BAR_HEIGHT))
            .flex_none()
            .gap_1()
            .px_2()
            .border_b_1()
            .border_color(p.border)
            .bg(p.bg)
            .on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            });
        if !self.sidebar {
            bar = bar.pl(px(TRAFFIC_LIGHT_SPACE));
        }
        for (index, id) in ids.iter().copied().enumerate() {
            let Some(session) = self.session(id) else { continue };
            let view = session.view.read(cx);
            let selected = Some(id) == active;
            let label = format!("{}  {}", index + 1, view.display_name());
            let bell = view.unseen_bell;
            bar = bar.child(
                div()
                    .id(("tab", id))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .h(px(26.0))
                    .max_w(px(220.0))
                    .px_2()
                    .rounded_md()
                    .text_sm()
                    .text_color(if selected { p.text } else { p.muted })
                    .when(selected, |d| d.bg(p.accent_fill))
                    .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
                    .child(div().overflow_hidden().text_ellipsis().whitespace_nowrap().child(label))
                    .when(bell, |d| d.child(div().size(px(6.0)).rounded_full().bg(p.warning)))
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
        bar.child(
            div()
                .id("new-tab")
                .px_2()
                .h(px(26.0))
                .flex()
                .items_center()
                .rounded_md()
                .text_color(p.muted)
                .hover(|s| s.bg(p.hover).text_color(p.text))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.new_terminal(&NewTerminal, window, cx)))
                .child("＋"),
        )
        .into_any_element()
    }

    fn render_terminal_row(&self, id: u64, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let session = self.session(id).expect("一覧の端末は開いている");
        let view = session.view.read(cx);
        let selected = self.active_id() == Some(id);
        let program = view.process.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        let detail = format!("{program} · {}", short_path(&view.cwd()));
        div()
            .id(("row", id))
            .flex()
            .flex_col()
            .mx_2()
            .px_2()
            .py_1()
            .rounded_md()
            .when(selected, |d| d.bg(p.accent_fill))
            .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.select(id, window, cx)))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .text_sm()
                    .text_color(p.text)
                    .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(view.display_name()))
                    .when(view.unseen_bell, |d| d.child(div().size(px(6.0)).rounded_full().bg(p.warning))),
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
            let count = self.sessions.iter().filter(|s| s.workspace == w.id).count();
            let label = if count > 0 { format!("{} {}", w.name, count) } else { w.name.clone() };
            workspaces = workspaces.child(
                div()
                    .id(("workspace", index))
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
                    .child(label),
            );
        }

        // ドラフトのリポジトリごとに、その中で動いている端末をまとめる
        let ids = self.workspace_ids();
        let cwds: HashMap<u64, String> = ids
            .iter()
            .map(|id| (*id, self.session(*id).map(|s| s.view.read(cx).cwd().display().to_string()).unwrap_or_default()))
            .collect();
        let cwd_of = |id: u64| cwds.get(&id).cloned().unwrap_or_default();
        let drafts: Vec<&Project> = self.projects.projects.iter().filter(|p| p.workspace == ws && p.draft).collect();
        let owner = |cwd: &str| -> Option<String> {
            drafts.iter().filter(|p| contains_path(&p.path, cwd)).max_by_key(|p| p.path.len()).map(|p| p.path.clone())
        };
        let mut list = div().id("sidebar-list").flex().flex_col().flex_1().overflow_y_scroll().gap(px(2.0)).pb_2();
        for project in &drafts {
            let members: Vec<u64> = ids.iter().copied().filter(|id| owner(&cwd_of(*id)).as_deref() == Some(project.path.as_str())).collect();
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
            for id in members {
                list = list.child(self.render_terminal_row(id, p, cx));
            }
        }
        let others: Vec<u64> = ids.iter().copied().filter(|id| owner(&cwd_of(*id)).is_none()).collect();
        if !others.is_empty() {
            if !drafts.is_empty() {
                list = list.child(div().mt_2().mx_2().px_2().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.muted).child("その他"));
            }
            for id in others {
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        let font = cx.global::<Appearance>().font.clone();
        let error = cx.global::<Appearance>().error.clone().or_else(|| self.notice.clone());
        let active_view = self.active_id().and_then(|id| self.session(id)).map(|s| s.view.clone());

        let content: AnyElement = match active_view {
            Some(view) => div().flex_1().min_h_0().bg(p.term_bg).child(view).into_any_element(),
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

        div()
            .key_context("Terp")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_row()
            .font_family(font.family.clone())
            .text_color(p.text)
            .on_action(cx.listener(Self::new_terminal))
            .on_action(cx.listener(Self::close_tab))
            .on_action(cx.listener(Self::recent_tab))
            .on_action(cx.listener(Self::open_config))
            .on_action(cx.listener(|app, _: &NextTab, w, cx| app.cycle_tab(1, w, cx)))
            .on_action(cx.listener(|app, _: &PrevTab, w, cx| app.cycle_tab(-1, w, cx)))
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
                    .child(self.render_tab_bar(&p, cx))
                    .when_some(error, |d, error| {
                        d.child(div().px_3().py_1().text_xs().bg(p.active).text_color(p.warning).child(error))
                    })
                    .child(content),
            )
    }
}
