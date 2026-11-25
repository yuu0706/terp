// 新しいリポジトリの見回り。その他のターミナルの場所が git のリポジトリの中なら一覧に足し、
// その他の端末の直下で git の管理が始まったときと、エージェントがリポジトリのファイルを編集しているときは、
// まとめるかを右下の案内で尋ねる（端末とリポジトリの組ごとに1回）。
use crate::app::{Palette, TerpApp};
use crate::projects;
use gpui::{AnyElement, ClickEvent, Context, FontWeight, MouseButton, SharedString, div, prelude::*, px};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone)]
pub struct Offer {
    pub terminal: u64,
    pub root: PathBuf,
    pub title: String,
    pub body: String,
    pub accept: String,
}

#[derive(Default)]
pub struct Offers {
    pub queue: Vec<Offer>,
    checked: HashSet<(String, PathBuf)>,
    offered: HashSet<(u64, PathBuf)>,
    running: bool,
    turn: u64,
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// 場所の直下で、since より後に .git ができたフォルダ（隠しフォルダと、.git がファイルのものを除く。最大500項目）
pub fn new_repos(dir: &Path, since: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .take(500)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let git = e.path().join(".git");
            let meta = std::fs::metadata(&git).ok()?;
            (meta.is_dir() && meta.created().ok()? >= since).then(|| e.path())
        })
        .collect()
}

impl TerpApp {
    pub(crate) fn scan_new_repos(&mut self, cx: &mut Context<Self>) {
        if self.offers.running {
            return;
        }
        self.offers.turn += 1;
        let known: Vec<String> = self.projects.projects.iter().map(|p| p.path.clone()).collect();
        let mut loose = Vec::new();
        for w in &self.projects.workspaces {
            for id in self.tree(&w.id, cx).others {
                if let Some(s) = self.session(id) {
                    let v = s.view.read(cx);
                    let place = v.work_path.clone().unwrap_or_else(|| v.cwd());
                    let edits: Vec<PathBuf> = if self.offers.turn % 3 == 0 { v.edits.iter().map(|(p, _)| p.clone()).collect() } else { Vec::new() };
                    loose.push((id, w.id.clone(), place, v.created_at, v.is_agent(), edits));
                }
            }
        }
        let to_check: Vec<(u64, String, PathBuf)> = loose
            .iter()
            .filter(|(_, ws, place, ..)| !self.offers.checked.contains(&(ws.clone(), place.clone())))
            .map(|(id, ws, place, ..)| (*id, ws.clone(), place.clone()))
            .collect();
        for (_, ws, place) in &to_check {
            self.offers.checked.insert((ws.clone(), place.clone()));
        }
        self.offers.running = true;
        cx.spawn(async move |this, cx| {
            let (adopt, offers) = cx
                .background_executor()
                .spawn(async move {
                    // その他の端末の場所がリポジトリの中なら足す
                    let mut adopt = Vec::new();
                    for (_, ws, place) in to_check {
                        if let Ok(root) = crate::git::repo_root(&place) {
                            let root_s = root.display().to_string();
                            if !known.contains(&root_s) && !adopt.iter().any(|(r, _): &(String, String)| *r == root_s) {
                                adopt.push((root_s, ws));
                            }
                        }
                    }
                    let mut offers = Vec::new();
                    for (id, _, place, created, agent, edits) in &loose {
                        for repo in new_repos(place, *created) {
                            offers.push((*id, repo, *agent, false));
                        }
                        for file in edits {
                            if let Some(root) = file.parent().and_then(|d| crate::git::repo_root(d).ok())
                                && !known.contains(&root.display().to_string())
                            {
                                offers.push((*id, root, *agent, true));
                            }
                        }
                    }
                    (adopt, offers)
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.offers.running = false;
                let mut added = false;
                for (root, ws) in adopt {
                    if projects::add_project(&root, &ws).is_ok() {
                        added = true;
                    }
                }
                if added {
                    app.reload_projects(cx);
                }
                for (id, root, agent, edited) in offers {
                    if !app.offers.offered.insert((id, root.clone())) {
                        continue;
                    }
                    let Some(term) = app.session(id).map(|s| s.view.read(cx).display_name()) else { continue };
                    let repo = name(&root);
                    let offer = if edited {
                        Offer {
                            terminal: id,
                            title: format!("{repo} は git のリポジトリです"),
                            body: format!("この端末（{term}）は {repo} のファイルを編集しています。git のリポジトリとして一覧に表示しますか？"),
                            accept: "リポジトリとして表示".into(),
                            root,
                        }
                    } else {
                        Offer {
                            terminal: id,
                            title: format!("{repo} が git の管理を始めました"),
                            body: format!(
                                "この端末（{term}）を {repo} にまとめますか？ {}",
                                if agent { "claude の会話はそのまま続きます。" } else { "端末は閉じずにそのまま使えます。" }
                            ),
                            accept: format!("{repo} にまとめる"),
                            root,
                        }
                    };
                    app.offers.queue.push(offer);
                }
                cx.notify();
            });
        })
        .detach();
    }

    // まとめる: リポジトリを端末と同じワークスペースに登録し、端末をそこへまとめる（シェルの場所は変えない）
    fn accept_offer(&mut self, offer: Offer, cx: &mut Context<Self>) {
        let ws = self.session(offer.terminal).map(|s| s.workspace.clone()).unwrap_or_else(|| self.workspace());
        if let Err(err) = projects::add_project(&offer.root.display().to_string(), &ws) {
            self.show_toast(err.to_string(), cx);
            return;
        }
        self.set_work_path(offer.terminal, Some(offer.root.clone()), cx);
        self.reload_projects(cx);
    }

    pub(crate) fn render_offer(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let offer = self.offers.queue.iter().find(|o| self.session(o.terminal).is_some())?.clone();
        let (o1, o2) = (offer.clone(), offer.clone());
        Some(
            div()
                .id("repo-offer")
                .occlude()
                .absolute()
                .left(px(if self.sidebar { self.sidebar_width + 16.0 } else { 16.0 }))
                .bottom(px(16.0))
                .w(px(360.0))
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .rounded_lg()
                .border_1()
                .border_color(p.accent)
                .bg(p.solid_bg)
                .shadow_lg()
                .text_color(p.text)
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(offer.title.clone()))
                .child(div().text_sm().text_color(p.muted).child(offer.body.clone()))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap_2()
                        .child(
                            div()
                                .id("offer-later")
                                .px_3()
                                .py_1()
                                .rounded_md()
                                .border_1()
                                .border_color(p.border)
                                .text_sm()
                                .hover(|s| s.bg(p.hover))
                                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                                    app.offers.queue.retain(|o| !(o.terminal == o1.terminal && o.root == o1.root));
                                    cx.notify();
                                }))
                                .child("今はしない"),
                        )
                        .child(
                            div()
                                .id("offer-accept")
                                .px_3()
                                .py_1()
                                .rounded_md()
                                .bg(p.accent)
                                .text_color(p.on_accent)
                                .text_sm()
                                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                                    app.offers.queue.retain(|o| !(o.terminal == o2.terminal && o.root == o2.root));
                                    app.accept_offer(o2.clone(), cx);
                                }))
                                .child(SharedString::from(offer.accept.clone())),
                        ),
                )
                .into_any_element(),
        )
    }
}

