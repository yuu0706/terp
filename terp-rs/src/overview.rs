// 全体の一覧（⌘M）。全ワークスペースの端末を縮小した画面で並べ、検索・矢印キー・クリックで切り替える。
use crate::agent::AgentState;
use crate::app::{Mark, Palette, TerpApp, mark_dot, mark_of, short_path};
use crate::appearance::{Appearance, hsla};
use crate::input::{InputEvent, TextInput};
use gpui::{
    AnyElement, App, Bounds, ClickEvent, Context, Entity, Focusable, FontWeight, MouseButton, Pixels, SharedString, Subscription, Task,
    Window, canvas, deferred, div, prelude::*, px,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

const TAIL_LINES: usize = 8;

pub struct Overview {
    input: Entity<TextInput>,
    selected: Option<u64>,
    // 選んでいる上端のタブ（all / open / repo:<path> / loose）
    tab: String,
    // 開いたときの状態で並びを決め、開いている間は動かさない
    rank: HashMap<u64, u8>,
    tiles: Rc<RefCell<Vec<(u64, Bounds<Pixels>)>>>,
    history: Vec<crate::snapshot::HistoryEntry>,
    _subscription: Subscription,
    _refresh: Task<()>,
}

#[derive(Clone)]
pub struct Item {
    pub id: u64,
    pub workspace: String,
    pub requirement: Option<String>,
    pub name: String,
    pub custom_name: Option<String>,
    pub repo_path: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub cwd: String,
    pub program: String,
    pub activity: Option<String>,
    pub open: bool,
    pub mark: Mark,
}

pub fn matches(item: &Item, query: &str) -> bool {
    let needle = query.trim().to_lowercase();
    needle.is_empty()
        || [item.requirement.as_deref(), Some(item.name.as_str()), item.repo_name.as_deref(), item.repo_path.as_deref(), item.branch.as_deref(), Some(item.cwd.as_str())]
            .into_iter()
            .flatten()
            .any(|v| v.to_lowercase().contains(&needle))
}

fn rank_of(mark: Mark) -> u8 {
    match mark {
        Mark::Agent(AgentState::Waiting) => 0,
        Mark::Agent(AgentState::Done) => 1,
        Mark::Agent(AgentState::Working) => 2,
        _ => 3,
    }
}

// 描いたタイルの位置から、矢印の向きの隣を選ぶ。左右は同じ行、上下は隣の行で横の位置が最も近いもの。端では止まる
pub fn neighbor(rects: &[(u64, Bounds<Pixels>)], id: u64, dx: i32, dy: i32) -> u64 {
    let Some((_, cur)) = rects.iter().find(|(i, _)| *i == id) else { return rects.first().map(|r| r.0).unwrap_or(id) };
    let top = |b: &Bounds<Pixels>| f32::from(b.origin.y);
    let left = |b: &Bounds<Pixels>| f32::from(b.origin.x);
    let center = |b: &Bounds<Pixels>| f32::from(b.origin.x) + f32::from(b.size.width) / 2.0;
    let mut candidates: Vec<&(u64, Bounds<Pixels>)> = rects
        .iter()
        .filter(|(i, b)| {
            *i != id
                && if dx != 0 {
                    (top(b) - top(cur)).abs() < 1.0 && if dx > 0 { left(b) > left(cur) } else { left(b) < left(cur) }
                } else if dy > 0 {
                    top(b) > top(cur) + 1.0
                } else {
                    top(b) < top(cur) - 1.0
                }
        })
        .collect();
    candidates.sort_by(|(_, a), (_, b)| {
        if dx != 0 {
            (left(a) - left(cur)).abs().total_cmp(&(left(b) - left(cur)).abs())
        } else {
            (top(a) - top(cur))
                .abs()
                .total_cmp(&(top(b) - top(cur)).abs())
                .then((center(a) - center(cur)).abs().total_cmp(&(center(b) - center(cur)).abs()))
        }
    });
    candidates.first().map(|(i, _)| *i).unwrap_or(id)
}

impl TerpApp {
    pub(crate) fn toggle_overview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overview.is_some() {
            self.close_overview(window, cx);
            return;
        }
        let input = cx.new(|cx| TextInput::new("要件・名前・リポジトリ・ブランチ・場所で絞り込む", cx));
        let subscription = cx.subscribe_in(&input, window, |app, _, event, window, cx| match event {
            InputEvent::Cancel => app.close_overview(window, cx),
            InputEvent::Submit { .. } => {
                if let Some(id) = app.overview.as_ref().and_then(|o| o.selected) {
                    app.close_overview(window, cx);
                    app.select(id, window, cx);
                }
            }
            InputEvent::Up => app.move_overview(0, -1, cx),
            InputEvent::Down => app.move_overview(0, 1, cx),
            InputEvent::EdgeLeft => app.move_overview(-1, 0, cx),
            InputEvent::EdgeRight => app.move_overview(1, 0, cx),
            InputEvent::Changed => app.keep_overview_selection(cx),
            InputEvent::Tab { back } => app.cycle_overview_tab(if *back { -1 } else { 1 }, cx),
        });
        let refresh = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });
        let rank = self.sessions.iter().map(|s| (s.id, rank_of(mark_of(s.view.read(cx))))).collect();
        let tab = self.overview_tab_memory.clone().unwrap_or_else(|| "all".into());
        window.focus(&input.focus_handle(cx), cx);
        self.menu = None;
        self.overview = Some(Overview {
            input,
            selected: self.active_id(),
            tab,
            rank,
            tiles: Rc::default(),
            history: crate::snapshot::load_history(),
            _subscription: subscription,
            _refresh: refresh,
        });
        cx.notify();
    }

    pub(crate) fn close_overview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(o) = self.overview.take() {
            self.overview_tab_memory = Some(o.tab);
            self.refocus(window, cx);
            cx.notify();
        }
    }

    fn overview_items(&self, cx: &App) -> Vec<Item> {
        let active_ws = self.workspace();
        let mut order: Vec<String> = vec![active_ws.clone()];
        order.extend(self.projects.workspaces.iter().map(|w| w.id.clone()).filter(|w| *w != active_ws));
        let mut items = Vec::new();
        for ws in order {
            let open: Vec<u64> = if ws == active_ws { self.layouts.get(&ws).map(|l| l.all_tabs()).unwrap_or_default() } else { Vec::new() };
            let tree = self.tree(&ws, cx);
            let mut push = |id: u64, repo: Option<(&crate::projects::Project, &crate::git::Worktree)>| {
                let Some(session) = self.session(id) else { return };
                let view = session.view.read(cx);
                let requirement = view.is_agent().then(|| view.agent_title.clone()).flatten();
                let cwd = view.cwd();
                items.push(Item {
                    id,
                    workspace: ws.clone(),
                    requirement,
                    name: view.display_name(),
                    custom_name: view.custom_name.clone(),
                    repo_path: repo.map(|(p, _)| p.path.clone()),
                    repo_name: repo.map(|(p, _)| p.name().to_string()),
                    branch: repo.map(|(_, w)| w.label()),
                    cwd: short_path(&cwd),
                    program: view.process.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
                    activity: view.activity.clone(),
                    open: open.contains(&id),
                    mark: mark_of(view),
                });
            };
            for repo in &tree.repos {
                for work in &repo.works {
                    for id in &work.terminals {
                        push(*id, Some((&repo.project, &work.worktree)));
                    }
                }
            }
            for id in &tree.others {
                push(*id, None);
            }
        }
        items
    }

    // 上端のタブ: すべて・開いているタブ・リポジトリ・その他のターミナル
    fn overview_tabs(items: &[Item]) -> Vec<(String, String, usize)> {
        let mut tabs = vec![("all".to_string(), "すべて".to_string(), items.len())];
        let open = items.iter().filter(|i| i.open).count();
        if open > 0 {
            tabs.push(("open".into(), "開いているタブ".into(), open));
        }
        let mut repos: Vec<String> = Vec::new();
        for item in items {
            if let Some(r) = &item.repo_path
                && !repos.contains(r)
            {
                repos.push(r.clone());
            }
        }
        for repo in repos {
            let members: Vec<&Item> = items.iter().filter(|i| i.repo_path.as_deref() == Some(repo.as_str())).collect();
            tabs.push((format!("repo:{repo}"), members[0].repo_name.clone().unwrap_or(repo.clone()), members.len()));
        }
        let loose = items.iter().filter(|i| i.repo_path.is_none()).count();
        if loose > 0 {
            tabs.push(("loose".into(), "その他のターミナル".into(), loose));
        }
        tabs
    }

    fn tab_items(items: Vec<Item>, tab: &str) -> Vec<Item> {
        match tab {
            "open" => items.into_iter().filter(|i| i.open).collect(),
            "loose" => items.into_iter().filter(|i| i.repo_path.is_none()).map(|i| Item { open: false, ..i }).collect(),
            t if t.starts_with("repo:") => {
                let repo = &t[5..];
                items.into_iter().filter(|i| i.repo_path.as_deref() == Some(repo)).map(|i| Item { open: false, ..i }).collect()
            }
            _ => items,
        }
    }

    fn visible_overview_items(&self, cx: &App) -> Vec<Item> {
        let Some(o) = &self.overview else { return Vec::new() };
        let query = o.input.read(cx).text().to_string();
        let items: Vec<Item> = self.overview_items(cx).into_iter().filter(|i| matches(i, &query)).collect();
        let tabs = Self::overview_tabs(&items);
        let tab = if tabs.iter().any(|t| t.0 == o.tab) { o.tab.clone() } else { "all".into() };
        Self::tab_items(items, &tab)
    }

    fn keep_overview_selection(&mut self, cx: &mut Context<Self>) {
        let visible = self.visible_overview_items(cx);
        if let Some(o) = self.overview.as_mut()
            && !o.selected.is_some_and(|s| visible.iter().any(|i| i.id == s))
        {
            o.selected = visible.first().map(|i| i.id);
        }
        cx.notify();
    }

    fn move_overview(&mut self, dx: i32, dy: i32, cx: &mut Context<Self>) {
        let Some(o) = self.overview.as_mut() else { return };
        let rects = o.tiles.borrow().clone();
        let Some(current) = o.selected.or_else(|| rects.first().map(|r| r.0)) else { return };
        o.selected = Some(neighbor(&rects, current, dx, dy));
        cx.notify();
    }

    pub(crate) fn cycle_overview_tab(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some(query) = self.overview.as_ref().map(|o| o.input.read(cx).text().to_string()) else { return };
        let items: Vec<Item> = self.overview_items(cx).into_iter().filter(|i| matches(i, &query)).collect();
        let tabs = Self::overview_tabs(&items);
        let Some(o) = self.overview.as_mut() else { return };
        let at = tabs.iter().position(|t| t.0 == o.tab).unwrap_or(0) as isize;
        o.tab = tabs[(at + step).rem_euclid(tabs.len() as isize) as usize].0.clone();
        self.keep_overview_selection(cx);
    }

    pub(crate) fn render_overview(&self, p: &Palette, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let o = self.overview.as_ref()?;
        let query = o.input.read(cx).text().to_string();
        let all: Vec<Item> = self.overview_items(cx);
        let any = !all.is_empty();
        let filtered: Vec<Item> = all.into_iter().filter(|i| matches(i, &query)).collect();
        let tabs = Self::overview_tabs(&filtered);
        let tab = if tabs.iter().any(|t| t.0 == o.tab) { o.tab.clone() } else { "all".to_string() };
        let mut items = Self::tab_items(filtered, &tab);
        items.sort_by_key(|i| o.rank.get(&i.id).copied().unwrap_or(3));
        let visible: Vec<u64> = self.layout().map(|l| l.visible()).unwrap_or_default();
        let appearance = cx.global::<Appearance>();
        let theme = appearance.theme.clone();
        let font = appearance.font.family.clone();
        o.tiles.borrow_mut().clear();

        let mut tab_row = div().id("overview-tabs").flex().flex_row().gap_1().overflow_x_scroll();
        for (key, label, count) in &tabs {
            let selected = *key == tab;
            let k = key.clone();
            tab_row = tab_row.child(
                div()
                    .id(SharedString::from(format!("ov-tab-{key}")))
                    .flex_none()
                    .px_2()
                    .py(px(3.0))
                    .rounded_md()
                    .text_sm()
                    .when(selected, |d| d.bg(p.accent_fill).text_color(p.text))
                    .when(!selected, |d| d.text_color(p.muted).hover(|s| s.bg(p.hover)))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        if let Some(o) = app.overview.as_mut() {
                            o.tab = k.clone();
                        }
                        app.keep_overview_selection(cx);
                    }))
                    .child(format!("{label} {count}")),
            );
        }

        let mut body = div().id("overview-body").flex().flex_col().gap_4().flex_1().min_h_0().overflow_y_scroll().px_4().pb_4();
        if items.is_empty() {
            body = body.child(div().p_4().text_color(p.muted).child(if any { "合うターミナルはない" } else { "ターミナルはない" }));
        }
        // 所属ごとに、開いているタブ・リポジトリ・その他のターミナルの順にまとめる
        let mut workspaces: Vec<String> = Vec::new();
        for item in &items {
            if !workspaces.contains(&item.workspace) {
                workspaces.push(item.workspace.clone());
            }
        }
        for ws in workspaces {
            let members: Vec<&Item> = items.iter().filter(|i| i.workspace == ws).collect();
            let ws_name = self.projects.workspaces.iter().find(|w| w.id == ws).map(|w| w.name.clone()).unwrap_or_default();
            let mut section = div().flex().flex_col().gap_2().child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(ws_name));
            let mut groups: Vec<(String, Vec<&Item>)> = Vec::new();
            let open: Vec<&Item> = members.iter().copied().filter(|i| i.open).collect();
            if !open.is_empty() {
                groups.push(("開いているタブ".into(), open));
            }
            let rest: Vec<&Item> = members.iter().copied().filter(|i| !i.open).collect();
            let mut repos: Vec<String> = Vec::new();
            for i in &rest {
                if let Some(r) = &i.repo_path
                    && !repos.contains(r)
                {
                    repos.push(r.clone());
                }
            }
            for repo in repos {
                let g: Vec<&Item> = rest.iter().copied().filter(|i| i.repo_path.as_deref() == Some(repo.as_str())).collect();
                groups.push((g[0].repo_name.clone().unwrap_or(repo), g));
            }
            let loose: Vec<&Item> = rest.iter().copied().filter(|i| i.repo_path.is_none()).collect();
            if !loose.is_empty() {
                groups.push(("その他のターミナル".into(), loose));
            }
            for (label, group) in groups {
                let mut grid = div().flex().flex_row().flex_wrap().gap_3();
                for item in group {
                    grid = grid.child(self.render_tile(item, o, visible.contains(&item.id), p, &theme, font.clone(), cx));
                }
                section = section.child(div().text_base().font_weight(FontWeight::SEMIBOLD).text_color(p.text).child(label)).child(grid);
            }
            body = body.child(section);
        }

        let header = div()
            .flex()
            .flex_col()
            .gap_2()
            .px_4()
            .pt(px(44.0))
            .pb_2()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .border_1()
                            .border_color(p.border)
                            .bg(p.term_bg)
                            .child(crate::ui::icon("search", 14.0, p.muted))
                            .child(div().flex_1().child(o.input.clone())),
                    )
                    .child(
                        crate::ui::icon_button("overview-close", "close", "閉じる（Esc）", p.muted, p.hover, p.text)
                            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.close_overview(window, cx))),
                    ),
            )
            .child(tab_row);

        Some(
            deferred(
                div()
                    .id("overview")
                    .occlude()
                    .absolute()
                    .inset_0()
                    .size_full()
                    .flex()
                    .flex_col()
                    .bg(p.solid_bg)
                    .text_color(p.text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(header)
                    .child(div().flex().flex_row().flex_1().min_h_0().child(body).child(self.render_history_column(o, &query, p, cx))),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }

    // エージェントの会話の履歴の列。押すと動いている端末へ、無ければ同じ場所で会話を再開する
    fn render_history_column(&self, o: &Overview, query: &str, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let running: HashMap<String, u64> = self
            .sessions
            .iter()
            .filter_map(|s| {
                let v = s.view.read(cx);
                let a = v.agent_session.as_ref()?;
                let id = a.id.clone().or_else(|| a.file.as_deref().and_then(crate::snapshot::codex_id))?;
                Some((id, s.id))
            })
            .collect();
        let needle = query.trim().to_lowercase();
        let entries: Vec<&crate::snapshot::HistoryEntry> = o
            .history
            .iter()
            .filter(|e| {
                needle.is_empty()
                    || [e.title.as_str(), e.name.as_str(), &e.cwd.display().to_string(), e.agent.as_str()].iter().any(|v| v.to_lowercase().contains(&needle))
            })
            .collect();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut col = div()
            .id("overview-history")
            .w(px(320.0))
            .flex_none()
            .flex()
            .flex_col()
            .gap_1()
            .overflow_y_scroll()
            .pr_4()
            .pb_4()
            .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child("会話の履歴"));
        if o.history.is_empty() {
            col = col.child(div().text_xs().text_color(p.muted).child("まだ履歴はない。terp で動かした claude・codex の会話がここに残る"));
        } else if entries.is_empty() {
            col = col.child(div().text_xs().text_color(p.muted).child("合う会話はない"));
        }
        for (i, e) in entries.into_iter().take(200).enumerate() {
            let title = if !e.title.is_empty() {
                e.title.clone()
            } else if !e.name.is_empty() {
                e.name.clone()
            } else {
                "（題名なし）".into()
            };
            let place = self
                .projects
                .projects
                .iter()
                .filter(|p| crate::projects::contains_path(&p.path, &e.cwd.display().to_string()))
                .max_by_key(|p| p.path.len())
                .map(|p| p.name().to_string())
                .unwrap_or_else(|| e.cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            let open = running.get(&e.session_id).copied();
            let entry = e.clone();
            let (agent, sid) = (e.agent.clone(), e.session_id.clone());
            col = col.child(
                div()
                    .id(("hist-entry", i))
                    .group(SharedString::from(format!("hist-{i}")))
                    .flex()
                    .flex_col()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .hover(|s| s.bg(p.hover))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        app.close_overview(window, cx);
                        match open {
                            Some(id) => app.select(id, window, cx),
                            None => app.resume_history(&entry, window, cx),
                        }
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_1()
                            .text_sm()
                            .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(title))
                            .child(
                                crate::ui::icon_button(("hist-forget", i), "close", "履歴から消す（記録そのものは消さない）", p.muted, p.active, p.text)
                                    .invisible()
                                    .group_hover(SharedString::from(format!("hist-{i}")), |s| s.visible())
                                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                                        cx.stop_propagation();
                                        let _ = crate::snapshot::forget_history(&agent, &sid);
                                        if let Some(o) = app.overview.as_mut() {
                                            o.history = crate::snapshot::load_history();
                                        }
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(p.muted)
                            .child(format!("{} · {place} · {}{}", e.agent, crate::snapshot::history_time(e.last_used, now), if open.is_some() { " · 開いている" } else { "" })),
                    ),
            );
        }
        col.into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_tile(
        &self,
        item: &Item,
        o: &Overview,
        visible: bool,
        p: &Palette,
        theme: &crate::config::Theme,
        font: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selected = o.selected == Some(item.id);
        let main = item.requirement.clone().unwrap_or_else(|| item.name.clone());
        let mut meta: Vec<String> = Vec::new();
        for part in [
            if item.requirement.is_some() { item.custom_name.clone() } else { None },
            item.branch.clone().or_else(|| Some(item.cwd.clone())),
            item.activity.clone().or_else(|| Some(item.program.clone())),
        ]
        .into_iter()
        .flatten()
        {
            if !part.is_empty() && part != main && !meta.contains(&part) {
                meta.push(part);
            }
        }
        let tail = self.session(item.id).map(|s| s.view.read(cx).tail_lines(TAIL_LINES)).unwrap_or_default();
        let border = if selected {
            p.accent
        } else if visible {
            p.accent.opacity(0.6)
        } else {
            match item.mark {
                Mark::Agent(AgentState::Waiting) => p.warning,
                Mark::Agent(AgentState::Done) => p.success,
                _ => p.border,
            }
        };
        let tiles = o.tiles.clone();
        let id = item.id;
        div()
            .id(("tile", id))
            .relative()
            .w(px(300.0))
            .flex()
            .flex_col()
            .rounded_lg()
            .border_1()
            .when(selected || visible, |d| d.border_2())
            .border_color(border)
            .overflow_hidden()
            .hover(|s| s.border_color(p.accent))
            .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                app.close_overview(window, cx);
                app.select(id, window, cx);
            }))
            .child(canvas(move |bounds, _, _| tiles.borrow_mut().push((id, bounds)), |_, _, _, _| {}).absolute().size_full())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .px_2()
                    .py_1()
                    .when(selected, |d| d.bg(p.accent_fill))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap_1()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(div().pt(px(4.0)).children(mark_dot(item.mark, p)))
                            .child(div().flex_1().line_clamp(2).child(main)),
                    )
                    .when(!meta.is_empty(), |d| {
                        d.child(div().text_xs().text_color(p.muted).overflow_hidden().text_ellipsis().whitespace_nowrap().child(meta.join(" · ")))
                    }),
            )
            .child(
                div()
                    .h(px(TAIL_LINES as f32 * 14.0 + 12.0))
                    .px_2()
                    .py_1()
                    .bg(hsla(theme.background, 1.0))
                    .text_color(hsla(theme.foreground, 1.0))
                    .font_family(font)
                    .text_size(px(10.5))
                    .line_height(px(14.0))
                    .overflow_hidden()
                    .children(tail.into_iter().map(|line| div().whitespace_nowrap().overflow_hidden().child(line))),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn b(x: f32, y: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(y)), size(px(100.0), px(80.0)))
    }

    #[test]
    fn 矢印で隣のタイルへ移り端では止まる() {
        let rects = vec![(1, b(0.0, 0.0)), (2, b(110.0, 0.0)), (3, b(0.0, 90.0)), (4, b(110.0, 90.0))];
        assert_eq!(neighbor(&rects, 1, 1, 0), 2);
        assert_eq!(neighbor(&rects, 2, 1, 0), 2);
        assert_eq!(neighbor(&rects, 2, 0, 1), 4);
        assert_eq!(neighbor(&rects, 3, 0, -1), 1);
    }

    fn item(name: &str, repo: Option<&str>) -> Item {
        Item {
            id: 1,
            workspace: "w".into(),
            requirement: None,
            name: name.into(),
            custom_name: None,
            repo_path: repo.map(String::from),
            repo_name: repo.map(String::from),
            branch: Some("main".into()),
            cwd: "~/x".into(),
            program: "zsh".into(),
            activity: None,
            open: false,
            mark: Mark::None,
        }
    }

    #[test]
    fn 名前やブランチで大文字小文字を区別せず絞り込む() {
        assert!(matches(&item("Login", None), "login"));
        assert!(matches(&item("x", Some("/r/terp")), "TERP"));
        assert!(matches(&item("x", None), "MAIN"));
        assert!(!matches(&item("x", None), "zzz"));
    }
}
