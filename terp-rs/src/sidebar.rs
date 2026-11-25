// 左の一覧。リポジトリ > 作業（worktree）> ターミナルの3段と、その他のターミナル、ワークスペースの切り替え。
use crate::agent::AgentState;
use crate::app::{DraggedTab, Mark, Palette, TerpApp, mark_dot, mark_of, short_path};
use crate::config::home_dir;
use crate::git::{self, Worktree};
use crate::overlay::{Choice, DialogSpec, MenuItem, action};
use crate::projects::{self, Project, contains_path};
use crate::ui::{agent_icon, icon, icon_button};
use gpui::{
    AnyElement, App, ClickEvent, Context, ExternalPaths, FontWeight, MouseButton, MouseDownEvent, PathPromptOptions,
    SharedString, Window, div, prelude::*, px,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;

// 作業ごとの端末
pub struct Work {
    pub worktree: Worktree,
    pub terminals: Vec<u64>,
}

pub struct RepoGroup {
    pub project: Project,
    pub works: Vec<Work>,
}

pub struct Tree {
    pub repos: Vec<RepoGroup>,
    pub others: Vec<u64>,
}

fn priority(mark: Mark) -> u8 {
    match mark {
        Mark::Agent(AgentState::Waiting) => 3,
        Mark::Agent(AgentState::Done) => 2,
        Mark::Agent(AgentState::Working) => 1,
        _ => 0,
    }
}

impl TerpApp {
    pub(crate) fn worktrees_of(&self, project: &Project) -> Vec<Worktree> {
        match self.repos.get(&project.path) {
            Some(list) if !list.is_empty() => list.clone(),
            _ => vec![Worktree { path: PathBuf::from(&project.path), main: true, ..Worktree::default() }],
        }
    }

    // 端末を、そのワークスペースで作業場所を含む最も深い作業に振り分ける
    pub(crate) fn placement(&self, id: u64, cx: &App) -> Option<(String, PathBuf)> {
        let session = self.session(id)?;
        let view = session.view.read(cx);
        let cwd = view.work_path.clone().unwrap_or_else(|| view.cwd()).display().to_string();
        self.projects
            .projects
            .iter()
            .filter(|p| p.workspace == session.workspace)
            .flat_map(|p| self.worktrees_of(p).into_iter().map(move |w| (p.path.clone(), w.path)))
            .filter(|(_, w)| contains_path(&w.display().to_string(), &cwd))
            .max_by_key(|(_, w)| w.as_os_str().len())
    }

    pub(crate) fn tree(&self, workspace: &str, cx: &App) -> Tree {
        let ids = self.workspace_ids(workspace);
        let placed: HashMap<u64, (String, PathBuf)> = ids.iter().filter_map(|id| self.placement(*id, cx).map(|p| (*id, p))).collect();
        let active_repo = self.active_id().and_then(|a| placed.get(&a)).map(|(r, _)| r.clone());
        let mut repos = Vec::new();
        for project in self.projects.projects.iter().filter(|p| p.workspace == workspace) {
            let has_terminals = placed.values().any(|(r, _)| *r == project.path);
            // 表示中のタブがドラフトに無いリポジトリにあれば、一時的に出す
            if !project.draft && !has_terminals && active_repo.as_deref() != Some(project.path.as_str()) {
                continue;
            }
            let works = self
                .worktrees_of(project)
                .into_iter()
                .map(|w| {
                    let terminals = ids.iter().copied().filter(|id| placed.get(id).is_some_and(|(_, p)| *p == w.path)).collect();
                    Work { worktree: w, terminals }
                })
                .collect();
            repos.push(RepoGroup { project: project.clone(), works });
        }
        let others = ids.iter().copied().filter(|id| !placed.contains_key(id)).collect();
        Tree { repos, others }
    }

    // 左の一覧の並び（ワークスペースの順に、リポジトリ・作業ごと、その他は最後）
    pub(crate) fn list_order(&self, cx: &App) -> Vec<u64> {
        let mut order = Vec::new();
        for w in &self.projects.workspaces {
            let tree = self.tree(&w.id, cx);
            for repo in tree.repos {
                for work in repo.works {
                    order.extend(work.terminals);
                }
            }
            order.extend(tree.others);
        }
        order
    }

    // ⌘T の場所。表示中の端末が作業の中ならその一番上、それ以外はホーム
    pub(crate) fn new_terminal_place(&self, cx: &App) -> PathBuf {
        self.active_id().and_then(|id| self.placement(id, cx)).map(|(_, w)| w).unwrap_or_else(home_dir)
    }

    pub(crate) fn refresh_repos(&mut self, cx: &mut Context<Self>) {
        if self.repos_loading {
            return;
        }
        self.repos_loading = true;
        let paths: Vec<String> = self.projects.projects.iter().map(|p| p.path.clone()).collect();
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move {
                    paths
                        .into_iter()
                        .filter(|p| Path::new(p).is_dir())
                        .filter_map(|p| git::list_worktrees(Path::new(&p)).ok().map(|list| (p, list)))
                        .collect::<HashMap<_, _>>()
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.repos_loading = false;
                if app.repos != found {
                    app.repos = found;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn open_work(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.workspace();
        let last = self
            .recent
            .iter()
            .rev()
            .chain(self.workspace_ids(&ws).iter().rev())
            .copied()
            .find(|id| self.placement(*id, cx).is_some_and(|(_, w)| w == path));
        match last {
            Some(id) => self.select(id, window, cx),
            None => self.open_terminal(path, window, cx),
        }
    }

    fn open_others(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.workspace();
        let others = self.tree(&ws, cx).others;
        let last = self.recent.iter().rev().copied().find(|id| others.contains(id)).or_else(|| others.last().copied());
        match last {
            Some(id) => self.select(id, window, cx),
            None => self.open_terminal(home_dir(), window, cx),
        }
    }

    fn toggle_draft(&mut self, path: String, draft: bool, cx: &mut Context<Self>) {
        if let Err(err) = projects::set_draft(&path, draft) {
            self.notice = Some(format!("ドラフトを変えられない: {err}"));
        }
        self.reload_projects(cx);
    }

    fn forget_repo(&mut self, path: String, cx: &mut Context<Self>) {
        if let Err(err) = projects::remove_project(&path) {
            self.notice = Some(format!("一覧から外せない: {err}"));
        }
        self.reload_projects(cx);
    }

    pub(crate) fn reload_projects(&mut self, cx: &mut Context<Self>) {
        let active = self.projects.active_workspace.clone();
        self.projects = projects::Projects::load();
        if self.projects.workspaces.iter().any(|w| w.id == active) {
            self.projects.active_workspace = active;
        }
        self.refresh_repos(cx);
        cx.notify();
    }

    fn toggle_collapsed(&mut self, path: String, cx: &mut Context<Self>) {
        if let Some(i) = self.ui.collapsed_repos.iter().position(|p| *p == path) {
            self.ui.collapsed_repos.remove(i);
        } else {
            self.ui.collapsed_repos.push(path);
        }
        cx.notify();
    }

    fn set_view(&mut self, view: &str, cx: &mut Context<Self>) {
        self.ui.sidebar_view = view.into();
        cx.notify();
    }

    // フォルダを選ぶ画面からリポジトリを足す
    pub(crate) fn prompt_add_repo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("追加".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = receiver.await else { return };
            let _ = this.update(cx, |app, cx| app.add_repos(&paths, cx));
        })
        .detach();
    }

    // git の外のフォルダとファイルは足さず、理由を出す
    pub(crate) fn add_repos(&mut self, paths: &[PathBuf], cx: &mut Context<Self>) {
        let ws = self.workspace();
        let mut problems = Vec::new();
        for path in paths {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !path.is_dir() {
                problems.push(format!("フォルダではないため追加できない: {name}"));
                continue;
            }
            match git::repo_root(path) {
                Ok(root) => {
                    if let Err(err) = projects::add_project(&root.display().to_string(), &ws) {
                        problems.push(format!("追加できない: {err}"));
                    }
                }
                Err(_) => problems.push(format!("git のリポジトリではありません: {}", path.display())),
            }
        }
        self.notice = (!problems.is_empty()).then(|| problems.join(" / "));
        if self.ui.sidebar_view == "all" && problems.is_empty() {
            self.ui.sidebar_view = "draft".into();
        }
        self.reload_projects(cx);
    }

    pub(crate) fn new_work_dialog(&mut self, repo: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.workspace();
        let repo = repo
            .or_else(|| self.active_id().and_then(|id| self.placement(id, cx)).map(|(r, _)| r))
            .or_else(|| self.projects.projects.iter().find(|p| p.workspace == ws && p.draft).map(|p| p.path.clone()));
        let Some(repo) = repo else {
            self.notice = Some("作業を作るリポジトリがありません。「すべて」でリポジトリを追加してください".into());
            cx.notify();
            return;
        };
        let base = git::default_base(Path::new(&repo));
        let agents = self.found_agents();
        let mut options: Vec<String> = Vec::new();
        for agent in &agents {
            options.push(agent.label.clone());
            if !agent.bypass_args.is_empty() {
                options.push(format!("{}（確認なし）", agent.label));
            }
        }
        options.push("起動しない".into());
        let name = Path::new(&repo).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let spec = DialogSpec {
            title: "新しい作業".into(),
            body: vec![format!("{name} に作業（worktree）を作ります")],
            fields: vec![("ブランチ名".into(), String::new(), "例: fix/login".into()), ("元にするブランチ".into(), base, String::new())],
            choice: Some(Choice { label: "作ったら起動する".into(), selected: options.len() - 1, options }),
            confirm: "作成".into(),
            danger: false,
            blocked: None,
        };
        let repo_path = PathBuf::from(&repo);
        self.open_dialog(
            spec,
            Rc::new(move |app, values, choice, window, cx| {
                let (branch, base) = (values[0].trim().to_string(), values[1].trim().to_string());
                if branch.is_empty() || base.is_empty() {
                    return Err("ブランチ名と元にするブランチを入れてください".into());
                }
                // 選んだエージェント（確認なしの別の行を含む）
                let mut launches = Vec::new();
                for agent in app.found_agents() {
                    launches.push(Some((agent.clone(), false)));
                    if !agent.bypass_args.is_empty() {
                        launches.push(Some((agent, true)));
                    }
                }
                let launch = launches.get(choice).cloned().flatten();
                if let Some(d) = app.dialog.as_mut() {
                    d.busy = Some("作成中…".into());
                }
                let repo = repo_path.clone();
                cx.spawn_in(window, async move |this, cx| {
                    let result = cx.background_executor().spawn(async move { git::add_worktree(&repo, &branch, &base) }).await;
                    let _ = this.update_in(cx, |app, window, cx| match result {
                        Ok(dest) => {
                            app.dialog = None;
                            app.refresh_repos(cx);
                            match launch {
                                Some((agent, bypass)) => app.launch_agent_at(&agent, bypass, dest, window, cx),
                                None => app.open_terminal(dest, window, cx),
                            }
                        }
                        Err(err) => {
                            if let Some(d) = app.dialog.as_mut() {
                                d.busy = None;
                                d.error = Some(err.to_string());
                            }
                            cx.notify();
                        }
                    });
                })
                .detach();
                Ok(())
            }),
            window,
            cx,
        );
    }

    fn delete_work_dialog(&mut self, repo: String, work: Worktree, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.workspace();
        let terminals: Vec<u64> =
            self.workspace_ids(&ws).into_iter().filter(|id| self.placement(*id, cx).is_some_and(|(_, w)| w == work.path)).collect();
        let changes = git::change_count(&work.path);
        let blocked = (changes > 0).then(|| {
            format!("変更のあるファイルが {changes} 件残っているため削除できません。コミットするか、変更を片付けてから削除してください。")
        });
        let spec = DialogSpec {
            title: format!("作業 {} を削除しますか？", work.label()),
            body: vec![format!(
                "この作業のターミナル {} 枚を閉じます。作業の場所を削除します。ブランチ {} は残ります。",
                terminals.len(),
                work.label()
            )],
            fields: Vec::new(),
            choice: None,
            confirm: "削除".into(),
            danger: true,
            blocked,
        };
        self.open_dialog(
            spec,
            Rc::new(move |app, _, _, window, cx| {
                git::remove_worktree(Path::new(&repo), &work.path).map_err(|e| e.to_string())?;
                for id in &terminals {
                    app.close(*id, false, window, cx);
                }
                app.refresh_repos(cx);
                Ok(())
            }),
            window,
            cx,
        );
    }

    fn workspace_menu(&mut self, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        let current = self.workspace();
        let mut items = Vec::new();
        for w in self.projects.workspaces.clone() {
            let marks: Vec<Mark> = self.workspace_ids(&w.id).iter().filter_map(|i| self.session(*i)).map(|s| mark_of(s.view.read(cx))).collect();
            let top = marks.iter().copied().max_by_key(|m| priority(*m)).filter(|m| priority(*m) > 0);
            let hint = top.map(|m| {
                let n = marks.iter().filter(|x| **x == m).count();
                let name = match m {
                    Mark::Agent(AgentState::Waiting) => "許可待ち",
                    Mark::Agent(AgentState::Done) => "終わった",
                    _ => "考え中",
                };
                format!("{name} {n}")
            });
            let id = w.id.clone();
            let mut item = MenuItem::new(w.name.clone(), action(move |app, window, cx| app.set_workspace(&id, window, cx))).checked(w.id == current);
            if let Some(hint) = hint {
                item = item.hint(hint);
            }
            items.push(item);
        }
        items.push(MenuItem::separator());
        items.push(MenuItem::new("新しいワークスペース…", action(|app, window, cx| app.workspace_name_dialog(None, window, cx))));
        let cur = current.clone();
        items.push(MenuItem::new("名前を変更…", action(move |app, window, cx| app.workspace_name_dialog(Some(cur.clone()), window, cx))));
        let reason = if self.projects.workspaces.len() <= 1 {
            Some("最後のワークスペースは削除できない")
        } else if !self.workspace_ids(&current).is_empty() || self.projects.projects.iter().any(|p| p.workspace == current) {
            Some("リポジトリかターミナルがあるため削除できない")
        } else {
            None
        };
        items.push(match reason {
            Some(reason) => MenuItem::disabled("ワークスペースを削除", reason),
            None => {
                let cur = current.clone();
                MenuItem::new(
                    "ワークスペースを削除",
                    action(move |app, window, cx| {
                        match projects::delete_workspace(&cur) {
                            Ok(()) => {
                                app.layouts.remove(&cur);
                                app.projects = projects::Projects::load();
                                app.refocus(window, cx);
                            }
                            Err(err) => app.notice = Some(err.to_string()),
                        }
                        cx.notify();
                    }),
                )
            }
        });
        self.open_menu(position, items, cx);
    }

    fn workspace_name_dialog(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let current = id.as_ref().and_then(|id| self.projects.workspaces.iter().find(|w| w.id == *id)).map(|w| w.name.clone()).unwrap_or_default();
        let spec = DialogSpec {
            title: if id.is_some() { "ワークスペースの名前を変更".into() } else { "新しいワークスペース".into() },
            body: Vec::new(),
            fields: vec![("名前".into(), current, "例: 仕事".into())],
            choice: None,
            confirm: if id.is_some() { "変更".into() } else { "作成".into() },
            danger: false,
            blocked: None,
        };
        self.open_dialog(
            spec,
            Rc::new(move |app, values, _, window, cx| {
                let name = values[0].trim().to_string();
                if name.is_empty() {
                    return Err("名前を入れてください".into());
                }
                match &id {
                    Some(id) => projects::rename_workspace(id, &name).map_err(|e| e.to_string())?,
                    None => {
                        let new = projects::create_workspace(&name).map_err(|e| e.to_string())?;
                        app.projects = projects::Projects::load();
                        app.set_workspace(&new, window, cx);
                    }
                }
                app.reload_projects(cx);
                Ok(())
            }),
            window,
            cx,
        );
    }

    fn move_terminal_to(&mut self, id: u64, workspace: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) else { return };
        let from = std::mem::replace(&mut session.workspace, workspace.clone());
        let view = session.view.clone();
        view.update(cx, |view, _| view.save_meta(&workspace));
        let recent = self.recent.clone();
        if let Some(layout) = self.layouts.get_mut(&from) {
            layout.remove_tab(id, &recent);
        }
        self.layouts.entry(workspace).or_default().add_tab(id);
        self.refocus(window, cx);
        cx.notify();
    }

    fn row_menu(&mut self, id: u64, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        let mut items = vec![MenuItem::new("名前を変更", action(move |app, window, cx| app.start_rename(id, window, cx)))];
        let config = &cx.global::<crate::appearance::Appearance>().config;
        if config.ai_assist && config.ai_name_terminal {
            items.push(MenuItem::new("AI で名前を付ける", action(move |app, _, cx| app.name_with_ai(id, cx))));
        }
        let current = self.session(id).map(|s| s.workspace.clone()).unwrap_or_default();
        if self.projects.workspaces.len() > 1 {
            items.push(MenuItem::separator());
            for w in self.projects.workspaces.clone() {
                if w.id == current {
                    continue;
                }
                let target = w.id.clone();
                items.push(MenuItem::new(
                    format!("ワークスペースへ移す: {}", w.name),
                    action(move |app, window, cx| app.move_terminal_to(id, target.clone(), window, cx)),
                ));
            }
        }
        items.push(MenuItem::separator());
        items.push(MenuItem::new("ターミナルを閉じる", action(move |app, window, cx| app.close(id, true, window, cx))));
        self.open_menu(position, items, cx);
    }

    fn repo_menu(&mut self, path: String, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        let current = self.projects.projects.iter().find(|p| p.path == path).map(|p| p.workspace.clone()).unwrap_or_default();
        let mut items = Vec::new();
        let p2 = path.clone();
        items.push(MenuItem::new("新しい作業…", action(move |app, window, cx| app.new_work_dialog(Some(p2.clone()), window, cx))));
        for w in self.projects.workspaces.clone() {
            if w.id == current {
                continue;
            }
            let (target, repo) = (w.id.clone(), path.clone());
            items.push(MenuItem::new(
                format!("ワークスペースへ移す: {}", w.name),
                action(move |app, _, cx| {
                    if let Err(err) = projects::move_project(&repo, &target) {
                        app.notice = Some(err.to_string());
                    }
                    app.reload_projects(cx);
                }),
            ));
        }
        let p3 = path.clone();
        items.push(MenuItem::separator());
        items.push(MenuItem::new("ドラフトから外す", action(move |app, _, cx| app.toggle_draft(p3.clone(), false, cx))));
        self.open_menu(position, items, cx);
    }

    // 幅を変えるつかみ所を付けた外枠
    pub(crate) fn render_sidebar_frame(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let handle = div()
            .id("sidebar-resize")
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(-3.0))
            .w(px(6.0))
            .cursor_col_resize()
            .tooltip(|_, cx| crate::tooltip::text("ドラッグで幅を変える。ダブルクリックで元の幅", cx))
            .when(self.sidebar_drag.is_some(), |d| d.bg(p.accent.opacity(0.6)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    if event.click_count == 2 {
                        app.sidebar_width = crate::state::SIDEBAR_DEFAULT;
                    } else {
                        app.sidebar_drag = Some((f32::from(event.position.x), app.sidebar_width));
                    }
                    cx.notify();
                }),
            );
        div()
            .relative()
            .w(px(self.sidebar_width))
            .flex_none()
            .h_full()
            .bg(p.bg)
            .border_r_1()
            .border_color(p.border)
            .child(self.render_sidebar(p, cx))
            .child(handle)
            .into_any_element()
    }

    pub(crate) fn render_sidebar(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let ws = self.workspace();
        let ws_name = self.projects.workspaces.iter().find(|w| w.id == ws).map(|w| w.name.clone()).unwrap_or_default();
        // 閉じたボタンには、全ワークスペースで最も急ぐ状態を出す
        let urgent = self
            .sessions
            .iter()
            .filter(|s| s.workspace != ws)
            .map(|s| mark_of(s.view.read(cx)))
            .max_by_key(|m| priority(*m))
            .filter(|m| priority(*m) > 1);
        let head = div()
            .id("sidebar-titlebar")
            .h(px(38.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap_1()
            .px_2()
            .on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                icon_button("sidebar-hide", "sidebar", "左の一覧を隠す（⌘B）", p.muted, p.hover, p.text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                        app.sidebar = false;
                        cx.notify();
                    })),
            )
            .child(
                icon_button("settings-open", "settings", "設定（⌘,）", p.muted, p.hover, p.text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.open_settings(window, cx))),
            );

        let switcher = div()
            .id("workspace-switch")
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .mx_2()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(p.border)
            .text_sm()
            .hover(|s| s.bg(p.hover))
            .tooltip(|_, cx| crate::tooltip::text("ワークスペースを切り替える（⌃⌘1〜9）", cx))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    app.workspace_menu(event.position, cx);
                }),
            )
            .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().font_weight(FontWeight::SEMIBOLD).child(ws_name))
            .children(urgent.and_then(|m| mark_dot(m, p)))
            .child(icon("chevron-down", 14.0, p.muted));
        let overview = div()
            .id("overview-open")
            .mx_2()
            .mt_1()
            .px_2()
            .py(px(3.0))
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .rounded_md()
            .text_xs()
            .text_color(p.muted)
            .hover(|s| s.bg(p.hover).text_color(p.text))
            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.toggle_overview(window, cx)))
            .child(icon("grid", 13.0, p.muted))
            .child("一覧")
            .child(div().flex_1())
            .child("⌘M");

        let all = self.ui.sidebar_view == "all";
        let view_tab = |id: &'static str, label: &'static str, selected: bool| {
            div()
                .id(id)
                .flex_1()
                .flex()
                .justify_center()
                .py(px(3.0))
                .rounded_md()
                .text_xs()
                .when(selected, |d| d.bg(p.accent_fill).text_color(p.text).font_weight(FontWeight::SEMIBOLD))
                .when(!selected, |d| d.text_color(p.muted).hover(|s| s.bg(p.hover)))
                .child(label)
        };
        let views = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .mx_2()
            .mt_2()
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_row()
                    .gap(px(2.0))
                    .p(px(2.0))
                    .rounded_lg()
                    .border_1()
                    .border_color(p.border)
                    .child(view_tab("view-all", "すべて", all).on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.set_view("all", cx))))
                    .child(view_tab("view-draft", "ドラフト", !all).on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.set_view("draft", cx)))),
            )
            .child(
                icon_button("add-project", "folder-plus", "リポジトリを追加", p.muted, p.hover, p.text)
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.prompt_add_repo(window, cx))),
            );

        let list = if all { self.render_all_view(p, cx) } else { self.render_draft_view(&ws, p, cx) };

        let foot = self.render_foot(p, cx);

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(head)
            .child(switcher)
            .child(overview)
            .child(views)
            .child(list)
            .child(foot)
            .into_any_element()
    }

    fn render_all_view(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let ws = self.workspace();
        let mut names: Vec<Project> = self.projects.projects.iter().filter(|x| x.workspace == ws).cloned().collect();
        names.sort_by_key(|x| x.name().to_lowercase());
        let mut list = div()
            .id("sidebar-all")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .gap(px(2.0))
            .py_2()
            .on_drop(cx.listener(|app, paths: &ExternalPaths, _, cx| app.add_repos(paths.paths(), cx)));
        if names.is_empty() {
            return self.render_no_projects(p, cx);
        }
        for project in names {
            let path = project.path.clone();
            let (p1, p2, p3) = (path.clone(), path.clone(), path.clone());
            let draft = project.draft;
            list = list.child(
                div()
                    .id(SharedString::from(format!("all-{path}")))
                    .group(SharedString::from(format!("all-{path}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .mx_2()
                    .px_2()
                    .h(px(28.0))
                    .rounded_md()
                    .text_sm()
                    .when(draft, |d| d.bg(p.accent_fill_dim))
                    .hover(|s| s.bg(p.hover))
                    .tooltip(move |_, cx| crate::tooltip::text(p3.clone(), cx))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.toggle_draft(p1.clone(), !draft, cx)))
                    .child(icon(if draft { "star-filled" } else { "star" }, 13.0, if draft { p.accent } else { p.muted }))
                    .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(project.name().to_string()))
                    .child(
                        icon_button(SharedString::from(format!("forget-{path}")), "close", "一覧から外す（ファイルは消さない）", p.muted, p.active, p.text)
                            .invisible()
                            .group_hover(SharedString::from(format!("all-{path}")), |s| s.visible())
                            .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                                cx.stop_propagation();
                                app.forget_repo(p2.clone(), cx);
                            })),
                    ),
            );
        }
        list.into_any_element()
    }

    fn render_no_projects(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("no-projects")
            .flex_1()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .text_xs()
            .text_color(p.muted)
            .on_drop(cx.listener(|app, paths: &ExternalPaths, _, cx| app.add_repos(paths.paths(), cx)))
            .child("リポジトリを追加すると、作業（worktree）ごとにターミナルをまとめられます。Finder のフォルダをここへ落としても追加できます")
            .child(
                div()
                    .id("empty-add-project")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .text_color(p.text)
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.prompt_add_repo(window, cx)))
                    .child(icon("folder-plus", 14.0, p.text))
                    .child("リポジトリを追加"),
            )
            .into_any_element()
    }

    fn render_draft_view(&self, ws: &str, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let tree = self.tree(ws, cx);
        let accent = p.accent;
        let mut list = div()
            .id("sidebar-list")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .gap(px(6.0))
            .px_2()
            .py_2()
            .drag_over::<ExternalPaths>(move |s, _, _, _| s.border_2().border_color(accent))
            .on_drop(cx.listener(|app, paths: &ExternalPaths, _, cx| app.add_repos(paths.paths(), cx)));
        let has_projects = self.projects.projects.iter().any(|x| x.workspace == ws);
        if tree.repos.is_empty() {
            if has_projects {
                list = list.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .p_2()
                        .text_xs()
                        .text_color(p.muted)
                        .child("ドラフトに入れたリポジトリはありません。「すべて」でリポジトリを押すと、ここに出ます")
                        .child(
                            div()
                                .id("show-all")
                                .px_2()
                                .py_1()
                                .rounded_md()
                                .border_1()
                                .border_color(p.border)
                                .text_color(p.text)
                                .hover(|s| s.bg(p.hover))
                                .on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.set_view("all", cx)))
                                .child("「すべて」を開く"),
                        ),
                );
            } else {
                list = list.child(self.render_no_projects(p, cx));
            }
        }
        for repo in tree.repos {
            list = list.child(self.render_repo(repo, p, cx));
        }
        // その他のターミナルは0件でも出す
        let mut others = self.card(p).child(
            div()
                .id("others-head")
                .flex()
                .flex_row()
                .items_center()
                .h(px(24.0))
                .px_2()
                .rounded_md()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.muted)
                .hover(|s| s.bg(p.hover))
                .tooltip(|_, cx| crate::tooltip::text("押すと、その他のターミナルの最後のタブへ移る。無ければホーム（~）で新しいターミナルを開く", cx))
                .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.open_others(window, cx)))
                .child("その他のターミナル"),
        );
        for id in tree.others {
            others = others.child(self.render_terminal_row(id, None, p, cx));
        }
        list.child(others).into_any_element()
    }

    fn card(&self, p: &Palette) -> gpui::Div {
        div().flex().flex_col().p_1().gap(px(1.0)).rounded_lg().bg(p.card)
    }

    fn render_repo(&self, repo: RepoGroup, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let path = repo.project.path.clone();
        let collapsed = self.ui.collapsed_repos.contains(&path);
        let all_ids: Vec<u64> = repo.works.iter().flat_map(|w| w.terminals.iter().copied()).collect();
        let summary = self.summary_mark(&all_ids, p, cx);
        let (p1, p2, p3, p4) = (path.clone(), path.clone(), path.clone(), path.clone());
        let head = div()
            .id(SharedString::from(format!("repo-{path}")))
            .group(SharedString::from(format!("repo-{path}")))
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .h(px(24.0))
            .px_1()
            .rounded_md()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(p.text)
            .hover(|s| s.bg(p.hover))
            .tooltip(move |_, cx| crate::tooltip::text(p4.clone(), cx))
            .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.toggle_collapsed(p1.clone(), cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    app.repo_menu(p3.clone(), event.position, cx);
                }),
            )
            .child(icon(if collapsed { "chevron-right" } else { "chevron-down" }, 12.0, p.muted))
            .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(repo.project.name().to_string()))
            .when(collapsed, |d| d.children(summary))
            .child(
                icon_button(SharedString::from(format!("undraft-{path}")), "star-filled", "ドラフトから外す（「すべて」に残る）", p.accent, p.active, p.text)
                    .invisible()
                    .group_hover(SharedString::from(format!("repo-{path}")), |s| s.visible())
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        app.toggle_draft(p2.clone(), false, cx);
                    })),
            )
            .child({
                let p5 = path.clone();
                icon_button(SharedString::from(format!("new-work-{path}")), "plus", "新しい作業", p.muted, p.active, p.text).on_click(cx.listener(
                    move |app, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        app.new_work_dialog(Some(p5.clone()), window, cx);
                    },
                ))
            });
        let mut card = self.card(p).child(head);
        if !collapsed {
            for work in repo.works {
                card = card.child(self.render_work(&path, &work, p, cx));
                for id in work.terminals {
                    card = card.child(self.render_terminal_row(id, Some(&work.worktree.path), p, cx));
                }
            }
        }
        card.into_any_element()
    }

    // 中の端末で最も急ぐ状態の印と、同じ状態の件数
    fn summary_mark(&self, ids: &[u64], p: &Palette, cx: &App) -> Option<AnyElement> {
        let marks: Vec<Mark> = ids.iter().filter_map(|i| self.session(*i)).map(|s| mark_of(s.view.read(cx))).collect();
        let top = marks.iter().copied().max_by_key(|m| priority(*m)).filter(|m| priority(*m) > 0)?;
        let count = marks.iter().filter(|m| **m == top).count();
        Some(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(3.0))
                .text_xs()
                .text_color(p.muted)
                .children(mark_dot(top, p))
                .when(count > 1, |d| d.child(count.to_string()))
                .into_any_element(),
        )
    }

    fn render_work(&self, repo: &str, work: &Work, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let w = work.worktree.clone();
        let path = w.path.clone();
        let selected = self.active_id().is_some_and(|a| work.terminals.contains(&a));
        let summary = self.summary_mark(&work.terminals, p, cx);
        let key = format!("work-{}", path.display());
        let (repo_s, w2) = (repo.to_string(), w.clone());
        let fill = p.accent_fill;
        div()
            .id(SharedString::from(key.clone()))
            .group(SharedString::from(key.clone()))
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .h(px(26.0))
            .px_2()
            .rounded_md()
            .text_sm()
            .when(selected, |d| d.bg(p.accent_fill_work).font_weight(FontWeight::SEMIBOLD))
            .hover(|s| s.bg(p.hover))
            .tooltip({
                let tip = path.display().to_string();
                move |_, cx| crate::tooltip::text(tip.clone(), cx)
            })
            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| app.open_work(path.clone(), window, cx)))
            .on_drop(cx.listener({
                let target = w.path.clone();
                move |app, dragged: &DraggedTab, _, cx| app.set_work_path(dragged.id, Some(target.clone()), cx)
            }))
            .drag_over::<DraggedTab>(move |s, _, _, _| s.bg(fill))
            .child(icon("branch", 13.0, p.muted))
            .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(w.label()))
            .when(w.main, |d| {
                d.child(div().flex_none().px_1().rounded_sm().border_1().border_color(p.border).text_xs().text_color(p.muted).child("本体"))
            })
            .when(w.changes > 0, |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("{key}-changes")))
                        .flex_none()
                        .px_1()
                        .rounded_sm()
                        .bg(p.active)
                        .text_xs()
                        .text_color(p.warning)
                        .tooltip(|_, cx| crate::tooltip::text("変更のあるファイル", cx))
                        .child(w.changes.to_string()),
                )
            })
            .children(summary)
            .when(!w.main, |d| {
                d.child(
                    icon_button(SharedString::from(format!("{key}-remove")), "trash", "作業を削除", p.muted, p.active, p.text)
                        .invisible()
                        .group_hover(SharedString::from(key.clone()), |s| s.visible())
                        .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                            cx.stop_propagation();
                            app.delete_work_dialog(repo_s.clone(), w2.clone(), window, cx);
                        })),
                )
            })
            .into_any_element()
    }

    // 端末を作業にまとめる（シェルの作業場所は変えない）
    pub(crate) fn set_work_path(&mut self, id: u64, path: Option<PathBuf>, cx: &mut Context<Self>) {
        let Some(session) = self.session(id) else { return };
        let workspace = session.workspace.clone();
        session.view.update(cx, |view, _| {
            view.work_path = path;
            view.save_meta(&workspace);
        });
        cx.notify();
    }

    pub(crate) fn render_terminal_row(&self, id: u64, work: Option<&Path>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(session) = self.session(id) else { return div().into_any_element() };
        let view = session.view.read(cx);
        let selected = self.active_id() == Some(id);
        let visible = self.is_visible(id);
        let mark = mark_of(view);
        let program = view.process.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        let name = view.display_name();
        let now = Instant::now();
        let status = view.agent.text(now);
        let cwd = view.cwd();
        let place = match work {
            Some(w) => cwd.strip_prefix(w).ok().map(|r| r.display().to_string()).filter(|r| !r.is_empty()).unwrap_or_default(),
            None => {
                let s = short_path(&cwd);
                if s == name { String::new() } else { s }
            }
        };
        let doing = matches!(mark, Mark::Agent(AgentState::Working) | Mark::Agent(AgentState::Waiting)).then(|| status.clone());
        let mut parts: Vec<String> = Vec::new();
        if let Some(doing) = doing.filter(|d| !d.is_empty()) {
            parts.push(doing);
        }
        if let Some(activity) = view.activity.clone().filter(|_| matches!(mark, Mark::Agent(AgentState::Working) | Mark::Agent(AgentState::Waiting))) {
            parts.push(activity);
        }
        if !program.is_empty() && program != name {
            parts.push(program.clone());
        }
        if !place.is_empty() {
            parts.push(place);
        }
        let detail = parts.join(" · ");
        let lead: AnyElement = if view.is_agent() { agent_icon(&program, 13.0, p.muted) } else { icon("terminal", 13.0, p.muted).into_any_element() };
        let tip = format!("{}\n{}", name, cwd.display());
        let group = SharedString::from(format!("row-{id}"));
        let clash = self.clash(id, cx);
        let subagents = view.subagents.clone();
        let row = div()
            .id(("row", id))
            .group(group.clone())
            .flex()
            .flex_col()
            .justify_center()
            .min_h(px(40.0))
            .pl(px(if work.is_some() { 18.0 } else { 8.0 }))
            .pr_1()
            .py_1()
            .rounded_md()
            .when(selected, |d| d.bg(p.accent_fill).border_l_2().border_color(p.accent))
            .when(!selected && visible, |d| d.bg(p.accent_fill_dim))
            .when(!selected, |d| d.hover(|s| s.bg(p.hover)))
            .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
            .on_click(cx.listener(move |app, event: &ClickEvent, window, cx| {
                if event.click_count() == 2 {
                    app.start_rename(id, window, cx);
                } else {
                    app.select(id, window, cx);
                }
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    app.row_menu(id, event.position, cx);
                }),
            )
            .on_drag(DraggedTab::new(id, name.clone()), |tab, _, _, cx| cx.new(|_| tab.clone()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .text_sm()
                    .text_color(p.text)
                    .children(mark_dot(mark, p))
                    .child(lead)
                    .child(self.name_label(id, name))
                    .when_some(clash, |d, (file, others)| {
                        let tip = format!("{file} を {} も書き換えた\n（30分以内。同じ場所で動いているエージェント同士）", others.join("・"));
                        d.child(
                            div()
                                .id(("clash", id))
                                .flex_none()
                                .px_1()
                                .rounded_sm()
                                .border_1()
                                .border_color(p.warning)
                                .text_xs()
                                .text_color(p.warning)
                                .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
                                .child("同じファイル"),
                        )
                    })
                    .child(
                        icon_button(("kill", id), "close", "ターミナルを閉じる", p.muted, p.active, p.text)
                            .invisible()
                            .group_hover(group, |s| s.visible())
                            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                                cx.stop_propagation();
                                app.close(id, true, window, cx);
                            })),
                    ),
            )
            .when(!detail.is_empty(), |d| {
                d.child(div().pl(px(18.0)).text_xs().text_color(p.muted).overflow_hidden().text_ellipsis().whitespace_nowrap().child(detail))
            });
        if subagents.is_empty() {
            return row.into_any_element();
        }
        // サブエージェント。終わったものは会話ごとに新しい20件まで、畳んで出す
        let running: Vec<_> = subagents.iter().filter(|s| s.running).cloned().collect();
        let finished: Vec<_> = subagents.iter().filter(|s| !s.running).take(20).cloned().collect();
        let open = self.expanded_subagents.contains(&id);
        let indent = if work.is_some() { 30.0 } else { 20.0 };
        let sub_row = |i: usize, s: &crate::transcript::Subagent| {
            let label = if !s.description.is_empty() {
                s.description.clone()
            } else if !s.agent_type.is_empty() {
                s.agent_type.clone()
            } else {
                "サブエージェント".into()
            };
            let since = s.started.unwrap_or(s.modified);
            div()
                .id(SharedString::from(format!("sub-{id}-{i}")))
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .pl(px(indent))
                .pr_1()
                .h(px(22.0))
                .text_xs()
                .text_color(p.muted)
                .child(if s.running {
                    div().flex_none().size(px(7.0)).rounded_full().border_1().border_color(p.accent).into_any_element()
                } else {
                    div().flex_none().size(px(7.0)).rounded_full().bg(p.muted).opacity(0.5).into_any_element()
                })
                .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(label))
                .child(div().flex_none().child(crate::transcript::elapsed_label(since)))
        };
        let mut column = div().flex().flex_col().child(row);
        for (i, s) in running.iter().enumerate() {
            column = column.child(sub_row(i, s));
        }
        if !finished.is_empty() {
            column = column.child(
                div()
                    .id(("sub-toggle", id))
                    .pl(px(indent))
                    .h(px(20.0))
                    .flex()
                    .items_center()
                    .text_xs()
                    .text_color(p.muted)
                    .hover(|s| s.text_color(p.text))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        if !app.expanded_subagents.remove(&id) {
                            app.expanded_subagents.insert(id);
                        }
                        cx.notify();
                    }))
                    .child(format!("{} 終わったもの {} 件", if open { "▾" } else { "▸" }, finished.len())),
            );
            if open {
                for (i, s) in finished.iter().enumerate() {
                    column = column.child(sub_row(1000 + i, s));
                }
            }
        }
        column.into_any_element()
    }

    fn render_foot(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let agents = self.found_agents();
        let mut row = div().flex().flex_row().flex_wrap().gap_1();
        for agent in agents {
            let tip = format!("{} を起動（⌥ で{}）", agent.label, if self.skip_approvals(cx) { "確認あり" } else { "確認なし" });
            let a2 = agent.clone();
            row = row.child(
                div()
                    .id(SharedString::from(format!("agent-{}", agent.command)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded_md()
                    .border_1()
                    .border_color(p.border)
                    .hover(|s| s.bg(p.hover))
                    .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
                    .on_click(cx.listener(move |app, event: &ClickEvent, window, cx| {
                        let bypass = app.skip_approvals(cx) != event.modifiers().alt;
                        let place = app.new_terminal_place(cx);
                        app.launch_agent_at(&a2, bypass, place, window, cx);
                    }))
                    .child(agent_icon(&agent.icon, 16.0, p.text)),
            );
        }
        let button = |id: &'static str, icon_name: &'static str, label: &'static str, key: &'static str, primary: bool| {
            div()
                .id(id)
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .px_2()
                .py(px(5.0))
                .rounded_md()
                .text_sm()
                .when(primary, |d| d.bg(p.accent).text_color(p.on_accent).hover(|s| s.opacity(0.9)))
                .when(!primary, |d| d.border_1().border_color(p.border).hover(|s| s.bg(p.hover)))
                .child(icon(icon_name, 14.0, if primary { p.on_accent } else { p.text }))
                .child(div().flex_1().child(label))
                .child(div().text_xs().opacity(0.7).child(key))
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .border_t_1()
            .border_color(p.border)
            .child(
                button("new-work", "branch", "新しい作業", "⌘N", false)
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.new_work_dialog(None, window, cx))),
            )
            .child(row)
            .child(
                button("new-terminal", "terminal", "新しいターミナル", "⌘T", true)
                    .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.new_terminal(&crate::app::NewTerminal, window, cx))),
            )
            .into_any_element()
    }
}
