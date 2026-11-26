// 右の面。「ファイル」（⇧⌘E）・「変更」（⇧⌘G）・「履歴」（⇧⌘H）を同時に1つ出す。
// 場所は表示中のタブの作業（worktree）の一番上。git の外ならその場所。
use crate::app::{Palette, TerpApp};
use crate::gitops::{self, Change, Commit, Diff, GraphRow, Status};
use crate::input::{InputEvent, TextInput};
use crate::overlay::DialogSpec;
use crate::ui::{icon, icon_button};
use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, FontWeight, Hsla, SharedString, Subscription, Task, Window, div, prelude::*, px,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PanelKind {
    Files,
    Changes,
    History,
    Transcript,
}

pub struct RightPanel {
    pub kind: PanelKind,
    root: Option<PathBuf>,
    // ファイル
    expanded: HashSet<PathBuf>,
    entries: HashMap<PathBuf, Vec<(String, bool)>>,
    // 変更
    status: Option<Status>,
    diff: Option<(String, String, Diff)>,
    commit_input: Entity<TextInput>,
    busy: Option<String>,
    log_open: bool,
    recent: Vec<Commit>,
    unpushed: HashSet<String>,
    // 履歴
    history: Vec<Commit>,
    graph: Vec<GraphRow>,
    in_head: HashSet<String>,
    all_branches: bool,
    query: Entity<TextInput>,
    file_filter: Option<String>,
    detail: Option<(Commit, Vec<Change>, Option<(String, Diff)>)>,
    loading: bool,
    // サブエージェントの記録（場所・見出し・読んだ中身）
    transcript: Option<(PathBuf, String, Vec<crate::transcript::Entry>)>,
    _refresh: Task<()>,
    _subscriptions: Vec<Subscription>,
}

fn list_dir(dir: &Path) -> Vec<(String, bool)> {
    let mut list: Vec<(String, bool)> = std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    (name != ".git" && name != ".DS_Store").then(|| (name, e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    list
}

fn weight(code: char) -> u8 {
    match code {
        'U' => 4,
        'M' | 'R' | 'C' | 'T' => 3,
        'D' => 2,
        'A' | '?' => 1,
        _ => 0,
    }
}

impl TerpApp {
    // 表示中のタブの作業の一番上
    fn panel_root(&self, cx: &App) -> Option<PathBuf> {
        let id = self.active_id()?;
        // ファイルのタブを見ているときは、そのファイルのあるリポジトリ
        if let Some(file) = self.file_tab(id) {
            let dir = file.editor.read(cx).path.parent().map(PathBuf::from)?;
            return gitops::toplevel(&dir).or(Some(dir));
        }
        let cwd = self.session(id)?.view.read(cx).cwd();
        self.placement(id, cx).map(|(_, w)| w).or_else(|| gitops::toplevel(&cwd)).or(Some(cwd))
    }

    pub(crate) fn toggle_panel(&mut self, kind: PanelKind, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.as_ref().is_some_and(|p| p.kind == kind) {
            self.panel = None;
            cx.notify();
            return;
        }
        if let Some(p) = self.panel.as_mut() {
            p.kind = kind;
            self.reload_panel(cx);
            return;
        }
        let commit_input = cx.new(|cx| {
            let mut i = TextInput::new("コミットメッセージ（⌘Enter でコミット）", cx);
            i.set_multiline(3);
            i
        });
        let query = cx.new(|cx| TextInput::new("件名・作者・ハッシュ", cx));
        let mut subs = Vec::new();
        subs.push(cx.subscribe_in(&commit_input, window, |app, _, event, window, cx| {
            if let InputEvent::Submit { .. } = event {
                app.commit_staged(window, cx);
            }
        }));
        subs.push(cx.subscribe_in(&query, window, |app, _, event, _, cx| {
            if let InputEvent::Changed | InputEvent::Submit { .. } = event {
                app.reload_history(cx);
            }
        }));
        let refresh = cx.spawn_in(window, async move |this, cx| {
            let mut tick = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_secs(3)).await;
                tick += 1;
                let alive = this
                    .update(cx, |app, cx| {
                        let kind = app.panel.as_ref().map(|p| p.kind);
                        match kind {
                            Some(PanelKind::History) if tick % 3 == 0 => app.reload_panel(cx),
                            Some(PanelKind::History) | None => {}
                            Some(_) => app.reload_panel(cx),
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        });
        self.panel = Some(RightPanel {
            kind,
            root: None,
            expanded: HashSet::new(),
            entries: HashMap::new(),
            status: None,
            diff: None,
            commit_input,
            busy: None,
            log_open: false,
            recent: Vec::new(),
            unpushed: HashSet::new(),
            history: Vec::new(),
            graph: Vec::new(),
            in_head: HashSet::new(),
            all_branches: false,
            query,
            file_filter: None,
            detail: None,
            loading: false,
            transcript: None,
            _refresh: refresh,
            _subscriptions: subs,
        });
        self.reload_panel(cx);
    }

    // 右の面のファイルの一覧で、そのフォルダまで開いて見せる。今の作業の外なら Finder で開く
    pub(crate) fn reveal_in_panel(&mut self, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let root = self.panel_root(cx);
        let Some(root) = root.filter(|r| dir.starts_with(r)) else {
            cx.open_with_system(&dir);
            self.show_toast("今の作業の外のフォルダのため、Finder で開いた".into(), cx);
            return;
        };
        if self.panel.as_ref().is_none_or(|p| p.kind != PanelKind::Files) {
            self.toggle_panel(PanelKind::Files, window, cx);
        }
        if let Some(panel) = self.panel.as_mut() {
            let mut at = dir.as_path();
            while at.starts_with(&root) && at != root {
                panel.expanded.insert(at.to_path_buf());
                let Some(parent) = at.parent() else { break };
                at = parent;
            }
        }
        self.reload_panel(cx);
    }

    pub(crate) fn reload_panel(&mut self, cx: &mut Context<Self>) {
        let root = self.panel_root(cx);
        let Some(panel) = self.panel.as_mut() else { return };
        if panel.root != root {
            panel.root = root.clone();
            panel.expanded.clear();
            panel.entries.clear();
            panel.diff = None;
            panel.detail = None;
            panel.history.clear();
            panel.file_filter = None;
        }
        let Some(root) = root else {
            cx.notify();
            return;
        };
        match panel.kind {
            PanelKind::History => return self.reload_history(cx),
            PanelKind::Transcript => return self.reload_transcript(cx),
            PanelKind::Files | PanelKind::Changes => {}
        }
        let dirs: Vec<PathBuf> = std::iter::once(root.clone()).chain(panel.expanded.iter().cloned()).collect();
        let want_log = panel.kind == PanelKind::Changes && panel.log_open;
        cx.spawn(async move |this, cx| {
            let (status, entries, recent, unpushed) = cx
                .background_executor()
                .spawn(async move {
                    let status = gitops::status(&root);
                    let entries: HashMap<PathBuf, Vec<(String, bool)>> = dirs.into_iter().map(|d| {
                        let l = list_dir(&d);
                        (d, l)
                    }).collect();
                    let (recent, unpushed) = match (&status, want_log) {
                        (Some(st), true) => (gitops::log(&st.top, false, 0, "", None).into_iter().take(30).collect(), gitops::unpushed(&st.top)),
                        _ => (Vec::new(), Vec::new()),
                    };
                    (status, entries, recent, unpushed)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.status = status;
                    p.entries = entries;
                    if want_log {
                        p.recent = recent;
                        p.unpushed = unpushed.into_iter().collect();
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // サブエージェントの記録を右の面で開く。動いている間は3秒ごとに読み直す
    pub(crate) fn open_transcript(&mut self, file: PathBuf, title: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_none() {
            self.toggle_panel(PanelKind::Transcript, window, cx);
        }
        if let Some(p) = self.panel.as_mut() {
            p.kind = PanelKind::Transcript;
            p.transcript = Some((file, title, Vec::new()));
        }
        self.reload_transcript(cx);
    }

    fn reload_transcript(&mut self, cx: &mut Context<Self>) {
        let Some(file) = self.panel.as_ref().and_then(|p| p.transcript.as_ref()).map(|t| t.0.clone()) else { return };
        cx.spawn(async move |this, cx| {
            let f = file.clone();
            let entries = cx.background_executor().spawn(async move { crate::transcript::transcript_entries(&f) }).await;
            let _ = this.update(cx, |app, cx| {
                if let Some(t) = app.panel.as_mut().and_then(|p| p.transcript.as_mut()).filter(|t| t.0 == file) {
                    t.2 = entries;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_transcript(&self, panel: &RightPanel, p: &Palette) -> AnyElement {
        let Some((_, title, entries)) = &panel.transcript else {
            return div().p_3().text_sm().text_color(p.muted).child("記録を読み込み中").into_any_element();
        };
        let mut col = div()
            .id("transcript")
            .flex()
            .flex_col()
            .gap_1()
            .size_full()
            .overflow_y_scroll()
            .p_2()
            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title.clone()));
        if entries.is_empty() {
            col = col.child(div().text_sm().text_color(p.muted).child("記録を待っている"));
        }
        for e in entries.iter().rev().take(300).collect::<Vec<_>>().into_iter().rev() {
            let (label, color) = match e.kind {
                "tool" => ("道具", p.accent),
                "result" => ("結果", p.muted),
                _ => ("話す", p.text),
            };
            col = col.child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .text_xs()
                    .child(div().w(px(56.0)).flex_none().text_color(p.muted).child(e.time.clone()))
                    .child(div().w(px(28.0)).flex_none().text_color(color).child(label))
                    .child(div().flex_1().min_w_0().text_color(if e.kind == "result" { p.muted } else { p.text }).child(e.text.clone())),
            );
        }
        col.into_any_element()
    }

    fn reload_history(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.panel.as_mut() else { return };
        let Some(root) = panel.root.clone() else { return };
        let query = panel.query.read(cx).text().to_string();
        let (all, file) = (panel.all_branches, panel.file_filter.clone());
        panel.loading = panel.history.is_empty();
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move {
                    let top = gitops::toplevel(&root)?;
                    let list = gitops::log(&top, all, 0, &query, file.as_deref());
                    let head = if all { gitops::head_commits(&top) } else { HashSet::new() };
                    let unpushed = gitops::unpushed(&top);
                    Some((list, head, unpushed))
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.loading = false;
                    match found {
                        Some((list, head, unpushed)) => {
                            p.graph = gitops::graph(&list);
                            p.history = list;
                            p.in_head = head;
                            p.unpushed = unpushed.into_iter().collect();
                        }
                        None => {
                            p.history.clear();
                            p.graph.clear();
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn panel_git<F>(&mut self, label: &'static str, work: F, cx: &mut Context<Self>)
    where
        F: FnOnce(PathBuf) -> anyhow::Result<String> + Send + 'static,
    {
        let Some(top) = self.panel.as_ref().and_then(|p| p.status.as_ref()).map(|s| s.top.clone()) else { return };
        if let Some(p) = self.panel.as_mut() {
            p.busy = Some(format!("{label} 中…"));
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { work(top) }).await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.busy = None;
                }
                if let Err(err) = result {
                    app.show_toast(err.to_string(), cx);
                }
                app.reload_panel(cx);
            });
        })
        .detach();
    }

    fn commit_staged(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panel.as_ref() else { return };
        let Some(st) = p.status.as_ref() else { return };
        let message = p.commit_input.read(cx).text().trim().to_string();
        if let Some(reason) = commit_blocked(st, &message) {
            self.show_toast(reason.into(), cx);
            return;
        }
        let input = p.commit_input.clone();
        input.update(cx, |i, cx| i.set_text("", cx));
        self.panel_git("コミット", move |top| gitops::commit(&top, &message), cx);
    }

    fn ai_commit_message(&mut self, cx: &mut Context<Self>) {
        let Some(top) = self.panel.as_ref().and_then(|p| p.status.as_ref()).map(|s| s.top.clone()) else { return };
        let config = cx.global::<crate::appearance::Appearance>().config.clone();
        if let Some(p) = self.panel.as_mut() {
            p.busy = Some("考え中…".into());
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let (stat, diff, subjects) = gitops::staged_summary(&top);
                    crate::assist::commit_message(&config, &diff, &stat, &subjects)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.busy = None;
                }
                match result {
                    Ok(text) => {
                        if let Some(input) = app.panel.as_ref().map(|p| p.commit_input.clone()) {
                            input.update(cx, |i, cx| i.set_text(&text, cx));
                        }
                    }
                    Err(err) => app.show_toast(err, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn show_diff(&mut self, path: String, kind: &'static str, cx: &mut Context<Self>) {
        let Some(top) = self.panel.as_ref().and_then(|p| p.status.as_ref()).map(|s| s.top.clone()) else { return };
        if self.panel.as_ref().and_then(|p| p.diff.as_ref()).is_some_and(|(p0, k, _)| *p0 == path && k == kind) {
            if let Some(p) = self.panel.as_mut() {
                p.diff = None;
            }
            cx.notify();
            return;
        }
        let file = path.clone();
        cx.spawn(async move |this, cx| {
            let d = cx.background_executor().spawn(async move { gitops::diff(&top, &file, kind) }).await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.diff = Some((path, kind.to_string(), d));
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn discard_dialog(&mut self, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        let Some(top) = self.panel.as_ref().and_then(|p| p.status.as_ref()).map(|s| s.top.clone()) else { return };
        let name = Path::new(&change.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (title, body) = if change.code == '?' {
            (format!("{name} をゴミ箱へ移しますか？"), "git で追跡していないファイルのため、ファイルそのものをゴミ箱へ移します。")
        } else {
            (
                format!("{name} の変更を取り消しますか？"),
                "ステージしていない変更を捨て、ステージした内容（無ければ最後のコミット）に戻します。今の中身はゴミ箱に控えを置くので、Finder のゴミ箱から戻せます。",
            )
        };
        let spec = DialogSpec { title, body: vec![body.into()], fields: Vec::new(), choice: None, confirm: "取り消す".into(), danger: true, blocked: None };
        let file = change.path.clone();
        self.open_dialog(
            spec,
            Rc::new(move |app, _, _, _, cx| {
                gitops::discard(&top, std::slice::from_ref(&file)).map_err(|e| e.to_string())?;
                app.reload_panel(cx);
                Ok(())
            }),
            window,
            cx,
        );
    }

    fn open_commit(&mut self, hash: String, cx: &mut Context<Self>) {
        let Some(root) = self.panel.as_ref().and_then(|p| p.root.clone()) else { return };
        if let Some(p) = self.panel.as_mut() {
            p.kind = PanelKind::History;
        }
        cx.spawn(async move |this, cx| {
            let found = cx.background_executor().spawn(async move { gitops::toplevel(&root).and_then(|t| gitops::show(&t, &hash)) }).await;
            let _ = this.update(cx, |app, cx| {
                if let Some(p) = app.panel.as_mut() {
                    p.detail = found.map(|(c, f)| (c, f, None));
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_commit_file(&mut self, file: String, cx: &mut Context<Self>) {
        let Some(p) = self.panel.as_mut() else { return };
        let Some((commit, _, open)) = p.detail.as_mut() else { return };
        if open.as_ref().is_some_and(|(f, _)| *f == file) {
            *open = None;
            cx.notify();
            return;
        }
        let Some(root) = p.root.clone() else { return };
        let commit = commit.clone();
        cx.spawn(async move |this, cx| {
            let f2 = file.clone();
            let d = cx.background_executor().spawn(async move { gitops::toplevel(&root).map(|t| gitops::commit_file_diff(&t, &commit, &f2)) }).await;
            let _ = this.update(cx, |app, cx| {
                if let Some((_, _, open)) = app.panel.as_mut().and_then(|p| p.detail.as_mut()) {
                    *open = d.map(|d| (file, d));
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn render_right_panel(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let panel = self.panel.as_ref()?;
        let tab = |id: &'static str, label: String, kind: PanelKind| {
            let selected = panel.kind == kind;
            div()
                .id(id)
                .px_2()
                .py(px(3.0))
                .rounded_md()
                .text_sm()
                .when(selected, |d| d.bg(p.accent_fill).font_weight(FontWeight::SEMIBOLD))
                .when(!selected, |d| d.text_color(p.muted).hover(|s| s.bg(p.hover)))
                .child(label)
        };
        let changes = panel.status.as_ref().map(|s| s.staged.len() + s.unstaged.len() + s.conflicted.len()).unwrap_or(0);
        let head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .h(px(38.0))
            .px_2()
            .border_b_1()
            .border_color(p.border)
            .child(tab("panel-files", "ファイル".into(), PanelKind::Files).on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.toggle_panel(PanelKind::Files, w, cx))))
            .child(
                tab("panel-changes", if changes > 0 { format!("変更 {changes}") } else { "変更".into() }, PanelKind::Changes)
                    .on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.toggle_panel(PanelKind::Changes, w, cx))),
            )
            .child(tab("panel-history", "履歴".into(), PanelKind::History).on_click(cx.listener(|app, _: &ClickEvent, w, cx| app.toggle_panel(PanelKind::History, w, cx))))
            .child(div().flex_1())
            .child(
                icon_button("panel-close", "close", "右の面を閉じる", p.muted, p.hover, p.text).on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                    app.panel = None;
                    cx.notify();
                })),
            );
        let body = match panel.kind {
            PanelKind::Files => self.render_files(panel, p, cx),
            PanelKind::Changes => self.render_changes(panel, p, cx),
            PanelKind::History => self.render_history(panel, p, cx),
            PanelKind::Transcript => self.render_transcript(panel, p),
        };
        Some(
            div()
                .w(px(380.0))
                .flex_none()
                .h_full()
                .flex()
                .flex_col()
                .bg(p.bg)
                .border_l_1()
                .border_color(p.border)
                .text_color(p.text)
                .child(head)
                .child(div().flex_1().min_h_0().child(body))
                .into_any_element(),
        )
    }

    fn render_files(&self, panel: &RightPanel, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(root) = panel.root.clone() else {
            return div().p_3().text_sm().text_color(p.muted).child("表示中のタブの場所がわかりません").into_any_element();
        };
        // 変更のあるファイルの色。フォルダは中の最も重いもの
        let mut marks: HashMap<PathBuf, char> = HashMap::new();
        if let Some(st) = &panel.status {
            for c in st.staged.iter().chain(st.unstaged.iter()).chain(st.conflicted.iter()) {
                let full = st.top.join(&c.path);
                marks.entry(full.clone()).and_modify(|m| if weight(c.code) > weight(*m) { *m = c.code }).or_insert(c.code);
                let mut dir = full.parent().map(Path::to_path_buf);
                while let Some(d) = dir {
                    if !d.starts_with(&root) || d == root {
                        break;
                    }
                    marks.entry(d.clone()).and_modify(|m| if weight(c.code) > weight(*m) { *m = c.code }).or_insert(c.code);
                    dir = d.parent().map(Path::to_path_buf);
                }
            }
        }
        let empty = panel.entries.get(&root).is_none_or(|e| e.is_empty());
        div()
            .id("files")
            .flex()
            .flex_col()
            .size_full()
            .overflow_y_scroll()
            .py_1()
            .child(self.render_subtree(panel, &root, 0, &marks, p, cx))
            .when(empty, |d| d.child(div().p_3().text_sm().text_color(p.muted).child("ファイルはありません")))
            .into_any_element()
    }

    fn render_subtree(&self, panel: &RightPanel, dir: &Path, depth: usize, marks: &HashMap<PathBuf, char>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let color = |code: char| -> Hsla {
            match code {
                'U' | 'D' => p.danger,
                'A' | '?' => p.success,
                _ => p.warning,
            }
        };
        let mut col = div().flex().flex_col();
        let Some(entries) = panel.entries.get(dir) else { return col.into_any_element() };
        for (name, is_dir) in entries.clone() {
            let path = dir.join(&name);
            let open = panel.expanded.contains(&path);
            let mark = marks.get(&path).copied();
            let p2 = path.clone();
            col = col.child(
                div()
                    .id(SharedString::from(format!("file-{}", path.display())))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .h(px(22.0))
                    .pl(px(8.0 + depth as f32 * 14.0))
                    .pr_2()
                    .text_sm()
                    .hover(|s| s.bg(p.hover))
                    .when_some(mark, |d, m| d.text_color(color(m)))
                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                        if is_dir {
                            if let Some(pnl) = app.panel.as_mut()
                                && !pnl.expanded.remove(&p2)
                            {
                                pnl.expanded.insert(p2.clone());
                            }
                            app.reload_panel(cx);
                        } else {
                            app.open_file_tab(p2.clone(), None, window, cx);
                        }
                    }))
                    .child(if is_dir { icon(if open { "chevron-down" } else { "chevron-right" }, 12.0, p.muted).into_any_element() } else { div().w(px(12.0)).into_any_element() })
                    .child(icon(if is_dir { "folder" } else { "file" }, 13.0, p.muted))
                    .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(name))
                    .when_some(mark.filter(|_| !is_dir), |d, m| d.child(div().text_xs().child(if m == '?' { 'A' } else { m }.to_string()))),
            );
            if is_dir && open {
                col = col.child(self.render_subtree(panel, &path, depth + 1, marks, p, cx));
            }
        }
        col.into_any_element()
    }

    fn render_changes(&self, panel: &RightPanel, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(st) = panel.status.clone() else {
            return div().p_3().text_sm().text_color(p.muted).child("このターミナルの場所は git のリポジトリではありません").into_any_element();
        };
        let branch = if st.branch.is_empty() || st.branch == "(detached)" {
            format!("（ブランチなし）{}", st.oid.chars().take(7).collect::<String>())
        } else {
            st.branch.clone()
        };
        let upstream = if st.upstream.is_empty() {
            "追跡先がありません。プッシュすると origin に同じ名前で作ります".to_string()
        } else if st.ahead > 0 || st.behind > 0 {
            format!("{} より {} 件進み、{} 件遅れ", st.upstream, st.ahead, st.behind)
        } else {
            format!("追跡先: {}", st.upstream)
        };
        let identity = if st.identity.0.is_empty() || st.identity.1.is_empty() {
            "コミットの名義が設定されていません（git config user.name / user.email）".to_string()
        } else {
            format!("コミットの名義: {} <{}>", st.identity.0, st.identity.1)
        };
        let busy = panel.busy.clone();
        let net = |id: &'static str, label: &'static str| {
            div().id(id).px_2().py(px(3.0)).rounded_md().border_1().border_color(p.border).text_xs().hover(|s| s.bg(p.hover)).child(label)
        };
        let mut col = div()
            .id("changes")
            .flex()
            .flex_col()
            .gap_2()
            .size_full()
            .overflow_y_scroll()
            .p_2()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .child(icon("branch", 13.0, p.muted))
                    .child(div().flex_1().text_sm().font_weight(FontWeight::SEMIBOLD).child(branch))
                    .child(net("git-fetch", "Fetch").on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.panel_git("Fetch", |t| gitops::fetch(&t), cx))))
                    .child(net("git-pull", "Pull").on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.panel_git("Pull", |t| gitops::pull(&t), cx))))
                    .child(net("git-push", "Push").on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.panel_git("Push", |t| gitops::push(&t), cx)))),
            )
            .child(div().text_xs().text_color(p.muted).child(upstream))
            .child(div().text_xs().text_color(p.muted).child(identity))
            .when_some(busy.clone(), |d, b| d.child(div().text_xs().text_color(p.accent).child(b)));

        let section = |title: String, items: &[Change], kind: &'static str, p: &Palette, cx: &mut Context<Self>| -> AnyElement {
            let mut s = div().flex().flex_col().gap(px(1.0));
            let all: Vec<String> = items.iter().map(|c| c.path.clone()).collect();
            let head = div()
                .flex()
                .flex_row()
                .items_center()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.muted)
                .child(div().flex_1().child(format!("{title} {}", items.len())));
            let head = match kind {
                "staged" => head.child(
                    div()
                        .id("unstage-all")
                        .px_1()
                        .rounded_sm()
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                            let files = all.clone();
                            app.panel_git("ステージから外す", move |t| gitops::unstage(&t, &files).map(|_| String::new()), cx)
                        }))
                        .child("すべて外す"),
                ),
                "unstaged" => head.child(
                    div()
                        .id("stage-all")
                        .px_1()
                        .rounded_sm()
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                            let files = all.clone();
                            app.panel_git("ステージ", move |t| gitops::stage(&t, &files).map(|_| String::new()), cx)
                        }))
                        .child("すべてステージ"),
                ),
                _ => head,
            };
            s = s.child(head);
            for (i, c) in items.iter().enumerate() {
                let c2 = c.clone();
                let c3 = c.clone();
                let c4 = c.clone();
                let path = c.path.clone();
                let diff_kind: &'static str = if c.code == '?' { "untracked" } else { kind };
                let key = format!("{kind}-{i}");
                s = s.child(
                    div()
                        .id(SharedString::from(key.clone()))
                        .group(SharedString::from(key.clone()))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .h(px(22.0))
                        .px_1()
                        .rounded_sm()
                        .text_sm()
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.show_diff(path.clone(), diff_kind, cx)))
                        .child(div().w(px(14.0)).text_xs().text_color(match c.code { 'U' | 'D' => p.danger, 'A' | '?' => p.success, _ => p.warning }).child(if c.code == '?' { "A".to_string() } else { c.code.to_string() }))
                        .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(c.path.clone()))
                        .when(kind == "unstaged", |d| {
                            d.child(
                                icon_button(SharedString::from(format!("{key}-discard")), "undo", "取り消す", p.muted, p.active, p.text)
                                    .invisible()
                                    .group_hover(SharedString::from(key.clone()), |s| s.visible())
                                    .on_click(cx.listener(move |app, _: &ClickEvent, window, cx| {
                                        cx.stop_propagation();
                                        app.discard_dialog(c2.clone(), window, cx);
                                    })),
                            )
                            .child(
                                icon_button(SharedString::from(format!("{key}-stage")), "plus", "ステージ", p.muted, p.active, p.text).on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                                    cx.stop_propagation();
                                    let f = vec![c3.path.clone()];
                                    app.panel_git("ステージ", move |t| gitops::stage(&t, &f).map(|_| String::new()), cx)
                                })),
                            )
                        })
                        .when(kind == "staged", |d| {
                            d.child(icon_button(SharedString::from(format!("{key}-unstage")), "minus", "ステージから外す", p.muted, p.active, p.text).on_click(cx.listener(
                                move |app, _: &ClickEvent, _, cx| {
                                    cx.stop_propagation();
                                    let f = vec![c4.path.clone()];
                                    app.panel_git("ステージから外す", move |t| gitops::unstage(&t, &f).map(|_| String::new()), cx)
                                },
                            )))
                        }),
                );
            }
            s.into_any_element()
        };
        if st.staged.is_empty() && st.unstaged.is_empty() && st.conflicted.is_empty() {
            col = col.child(div().text_sm().text_color(p.muted).child("変更はありません"));
        }
        if !st.conflicted.is_empty() {
            col = col.child(section("競合".into(), &st.conflicted, "conflicted", p, cx));
        }
        if !st.staged.is_empty() {
            col = col.child(section("ステージ済み".into(), &st.staged, "staged", p, cx));
        }
        if !st.unstaged.is_empty() {
            col = col.child(section("未ステージ".into(), &st.unstaged, "unstaged", p, cx));
        }
        if let Some((file, _, d)) = &panel.diff {
            col = col.child(self.render_diff(file, d, p));
        }
        let message = panel.commit_input.read(cx).text().trim().to_string();
        let blocked = commit_blocked(&st, &message);
        let ai = cx.global::<crate::appearance::Appearance>().config.clone();
        col = col
            .child(div().px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(panel.commit_input.clone()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .when(ai.ai_assist && ai.ai_commit_message, |d| {
                        d.child(
                            div()
                                .id("ai-commit")
                                .px_2()
                                .py(px(3.0))
                                .rounded_md()
                                .border_1()
                                .border_color(p.border)
                                .text_sm()
                                .hover(|s| s.bg(p.hover))
                                .on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.ai_commit_message(cx)))
                                .child("AI で書く"),
                        )
                    })
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("commit")
                            .px_3()
                            .py(px(3.0))
                            .rounded_md()
                            .bg(p.accent)
                            .text_color(p.on_accent)
                            .text_sm()
                            .when(blocked.is_some(), |d| d.opacity(0.5))
                            .when_some(blocked, |d, why| d.tooltip(move |_, cx| crate::tooltip::text(why, cx)))
                            .on_click(cx.listener(|app, _: &ClickEvent, window, cx| app.commit_staged(window, cx)))
                            .child("コミット"),
                    ),
            );
        // 最近の履歴（初めは畳む）
        let open = panel.log_open;
        col = col.child(
            div()
                .id("recent-log-toggle")
                .text_xs()
                .text_color(p.muted)
                .hover(|s| s.text_color(p.text))
                .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                    if let Some(p) = app.panel.as_mut() {
                        p.log_open = !p.log_open;
                    }
                    app.reload_panel(cx);
                }))
                .child(format!("{} 最近の履歴", if open { "▾" } else { "▸" })),
        );
        if open {
            if panel.recent.is_empty() {
                col = col.child(div().text_xs().text_color(p.muted).child("まだコミットがありません"));
            }
            for (i, c) in panel.recent.iter().enumerate() {
                let hash = c.hash.clone();
                let pushed = !panel.unpushed.contains(&c.hash);
                col = col.child(
                    div()
                        .id(("recent", i))
                        .flex()
                        .flex_row()
                        .gap_2()
                        .text_xs()
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.open_commit(hash.clone(), cx)))
                        .when(!pushed, |d| d.text_color(p.accent).child("↑"))
                        .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(c.subject.clone()))
                        .child(div().text_color(p.muted).child(gitops::ago(&c.date))),
                );
            }
            col = col.child(div().text_xs().text_color(p.muted).child("最近の 30 件。それより前は「履歴」の面で見られます"));
        }
        col.into_any_element()
    }

    fn render_diff(&self, file: &str, d: &Diff, p: &Palette) -> AnyElement {
        let mut box_ = div()
            .flex()
            .flex_col()
            .rounded_md()
            .border_1()
            .border_color(p.border)
            .bg(p.term_bg)
            .p_1()
            .font_family(SharedString::from("Menlo"))
            .text_xs()
            .child(div().pb_1().text_color(p.muted).child(file.to_string()));
        if d.binary {
            return box_.child("バイナリのファイルのため、差分を表示しません").into_any_element();
        }
        if d.text.trim().is_empty() {
            return box_.child("差分はありません").into_any_element();
        }
        for line in d.text.lines().take(2000) {
            let color = if line.starts_with('+') && !line.starts_with("+++") {
                p.success
            } else if line.starts_with('-') && !line.starts_with("---") {
                p.danger
            } else if line.starts_with("@@") {
                p.info
            } else {
                p.text
            };
            box_ = box_.child(div().whitespace_nowrap().text_color(color).child(if line.is_empty() { " ".to_string() } else { line.to_string() }));
        }
        if d.truncated {
            box_ = box_.child(div().text_color(p.muted).child("差分が長いため、5,000 行で打ち切りました"));
        }
        box_.into_any_element()
    }

    fn render_history(&self, panel: &RightPanel, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        if let Some((commit, files, open)) = &panel.detail {
            let mut col = div()
                .id("commit-detail")
                .flex()
                .flex_col()
                .gap_2()
                .size_full()
                .overflow_y_scroll()
                .p_2()
                .child(
                    div()
                        .id("detail-back")
                        .text_xs()
                        .text_color(p.muted)
                        .hover(|s| s.text_color(p.text))
                        .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                            if let Some(p) = app.panel.as_mut() {
                                p.detail = None;
                            }
                            cx.notify();
                        }))
                        .child("← 履歴へ戻る"),
                )
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(commit.subject.clone()))
                .child(div().text_xs().text_color(p.muted).child(format!("{} · {} · {}", commit.short, commit.author, gitops::ago(&commit.date))))
                .when(!commit.body.is_empty(), |d| d.child(div().text_xs().child(commit.body.clone())));
            for parent in &commit.parents {
                let h = parent.clone();
                col = col.child(
                    div()
                        .id(SharedString::from(format!("parent-{parent}")))
                        .text_xs()
                        .text_color(p.accent)
                        .hover(|s| s.opacity(0.8))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.open_commit(h.clone(), cx)))
                        .child(format!("親: {}", parent.chars().take(7).collect::<String>())),
                );
            }
            for (i, f) in files.iter().enumerate() {
                let path = f.path.clone();
                col = col.child(
                    div()
                        .id(("detail-file", i))
                        .flex()
                        .flex_row()
                        .gap_1()
                        .text_sm()
                        .hover(|s| s.bg(p.hover))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.toggle_commit_file(path.clone(), cx)))
                        .child(div().w(px(14.0)).text_xs().child(f.code.to_string()))
                        .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(match &f.from {
                            Some(from) => format!("{from} → {}", f.path),
                            None => f.path.clone(),
                        })),
                );
                if let Some((open_file, d)) = open
                    && *open_file == f.path
                {
                    col = col.child(self.render_diff(open_file, d, p));
                }
            }
            return col.into_any_element();
        }
        let all = panel.all_branches;
        let mut col = div().flex().flex_col().size_full();
        let header = div()
            .flex()
            .flex_col()
            .gap_1()
            .p_2()
            .child(div().px_2().py_1().rounded_md().border_1().border_color(p.border).bg(p.term_bg).text_sm().child(panel.query.clone()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_1()
                    .text_xs()
                    .child(
                        div()
                            .id("hist-current")
                            .px_2()
                            .rounded_md()
                            .when(!all, |d| d.bg(p.accent_fill))
                            .hover(|s| s.bg(p.hover))
                            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                                if let Some(p) = app.panel.as_mut() {
                                    p.all_branches = false;
                                }
                                app.reload_history(cx);
                            }))
                            .child("いまのブランチ"),
                    )
                    .child(
                        div()
                            .id("hist-all")
                            .px_2()
                            .rounded_md()
                            .when(all, |d| d.bg(p.accent_fill))
                            .hover(|s| s.bg(p.hover))
                            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                                if let Some(p) = app.panel.as_mut() {
                                    p.all_branches = true;
                                }
                                app.reload_history(cx);
                            }))
                            .child("すべてのブランチ"),
                    )
                    .when_some(panel.file_filter.clone(), |d, f| {
                        d.child(div().flex_1()).child(
                            div()
                                .id("hist-file-clear")
                                .px_2()
                                .rounded_md()
                                .hover(|s| s.bg(p.hover))
                                .tooltip(|_, cx| crate::tooltip::text("ファイルの絞り込みを解除", cx))
                                .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                                    if let Some(p) = app.panel.as_mut() {
                                        p.file_filter = None;
                                    }
                                    app.reload_history(cx);
                                }))
                                .child(format!("ファイル: {f} ×")),
                        )
                    }),
            );
        col = col.child(header);
        let mut list = div().id("history-list").flex().flex_col().flex_1().min_h_0().overflow_y_scroll();
        if panel.loading {
            list = list.child(div().p_3().text_sm().text_color(p.muted).child("履歴を読み込み中…"));
        } else if panel.history.is_empty() {
            let message = if panel.status.is_none() && panel.root.as_deref().and_then(gitops::toplevel).is_none() {
                "git のリポジトリではありません"
            } else {
                "当たるコミットがない。条件を変えて読み直してください"
            };
            list = list.child(div().p_3().text_sm().text_color(p.muted).child(message));
        }
        let lane_colors = |i: usize| -> Hsla {
            let palette = &cx.global::<crate::appearance::Appearance>().theme.palette;
            if i == 0 { p.accent } else { crate::appearance::hsla(palette[[4usize, 5, 6, 2, 3, 1][i % 6]], 1.0) }
        };
        for (i, (c, g)) in panel.history.iter().zip(panel.graph.iter()).enumerate() {
            let hash = c.hash.clone();
            let dim = all && !panel.in_head.is_empty() && !panel.in_head.contains(&c.hash);
            let mut lanes = div().relative().flex_none().w(px(8.0 * 14.0_f32.min(g.lanes.len().max(1) as f32 * 14.0) / 8.0 + 10.0)).h(px(22.0));
            for (lane, active) in g.lanes.iter().enumerate() {
                if *active {
                    lanes = lanes.child(div().absolute().left(px(5.0 + lane as f32 * 14.0)).top_0().bottom_0().w(px(2.0)).bg(lane_colors(lane).opacity(0.7)));
                }
            }
            lanes = lanes.child(
                div()
                    .absolute()
                    .left(px(2.0 + g.column as f32 * 14.0))
                    .top(px(7.0))
                    .size(px(8.0))
                    .rounded_full()
                    .when(g.merge, |d| d.border_2().border_color(lane_colors(g.column)).bg(p.bg))
                    .when(!g.merge, |d| d.bg(lane_colors(g.column))),
            );
            let (kind, rest) = match c.subject.split_once(':') {
                Some((k, r)) if k.len() <= 12 && !k.contains(' ') => (Some(format!("{k}:")), r.to_string()),
                _ => (None, c.subject.clone()),
            };
            let unpushed = panel.unpushed.contains(&c.hash);
            let tip = format!("{}\n{} · {}", c.short, c.author, c.date);
            list = list.child(
                div()
                    .id(("hist", i))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .h(px(22.0))
                    .px_2()
                    .text_sm()
                    .when(dim, |d| d.opacity(0.5))
                    .hover(|s| s.bg(p.hover))
                    .tooltip(move |_, cx| crate::tooltip::text(tip.clone(), cx))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| app.open_commit(hash.clone(), cx)))
                    .child(lanes)
                    .children(refs_badges(&c.refs, p))
                    .children(kind.map(|k| div().font_weight(FontWeight::SEMIBOLD).child(k)))
                    .child(div().flex_1().overflow_hidden().text_ellipsis().whitespace_nowrap().child(rest))
                    .when(!c.body.is_empty(), |d| d.child(div().text_xs().text_color(p.muted).child("↩")))
                    .when(unpushed, |d| d.child(div().text_xs().text_color(p.accent).child("↑"))),
            );
        }
        col.child(list).into_any_element()
    }
}

fn refs_badges(refs: &str, p: &Palette) -> Vec<AnyElement> {
    refs.split(", ")
        .filter(|r| !r.is_empty())
        .take(3)
        .map(|r| {
            let (label, color) = if let Some(b) = r.strip_prefix("HEAD -> ") {
                (b.to_string(), p.accent)
            } else if let Some(t) = r.strip_prefix("tag: ") {
                (t.to_string(), p.danger)
            } else if r.contains('/') {
                (r.to_string(), p.info)
            } else {
                (r.to_string(), p.success)
            };
            div().flex_none().px_1().rounded_sm().border_1().border_color(color).text_xs().text_color(color).child(label).into_any_element()
        })
        .collect()
}

// コミットのボタンを押せない理由
pub fn commit_blocked(st: &Status, message: &str) -> Option<&'static str> {
    if !st.conflicted.is_empty() {
        Some("競合を解決してからコミットしてください")
    } else if st.staged.is_empty() {
        Some("ステージ済みのファイルがありません")
    } else if message.trim().is_empty() {
        Some("コミットメッセージを入れてください")
    } else {
        None
    }
}
