// 画面の控え（~/.config/terp/gpui-tabs.json）。枠とタブの並び・文字の大きさの差・左の一覧の状態・閉じたタブを残す。
// 初めて開くときは、Electron 版の tabs.json から文字の大きさと左の一覧の状態を引き継ぐ。
use crate::config::config_dir;
use crate::panes::Layout;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub const CLOSED_LIMIT: usize = 20;
pub const SIDEBAR_DEFAULT: f32 = 248.0;
pub const SIDEBAR_MIN: f32 = 200.0;
pub const SIDEBAR_MAX: f32 = 520.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClosedTab {
    pub cwd: PathBuf,
    pub name: Option<String>,
    pub workspace: String,
}

// 小さいターミナルを最後に置いた位置と大きさ（画面の左上からの距離）と、その画面
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedQuick {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub display: Option<u64>,
}

// 枠のタブで開いていたファイル。key は枠の並びの中でこのファイルを指す番号
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedFile {
    pub key: u64,
    pub workspace: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    pub font_delta: i32,
    pub sidebar_hidden: bool,
    pub sidebar_width: f32,
    // 左の一覧の表示（draft: ドラフトのリポジトリ / all: 追加したすべて）
    pub sidebar_view: String,
    pub collapsed_repos: Vec<String>,
    // ワークスペースごとの枠。タブの番号は常駐のプロセスでのシェルの番号
    pub layouts: HashMap<String, Layout>,
    pub closed: Vec<ClosedTab>,
    pub files: Vec<SavedFile>,
    pub quick: Option<SavedQuick>,
}

impl Default for UiState {
    fn default() -> Self {
        UiState {
            font_delta: 0,
            sidebar_hidden: false,
            sidebar_width: SIDEBAR_DEFAULT,
            sidebar_view: "draft".into(),
            collapsed_repos: Vec::new(),
            layouts: HashMap::new(),
            closed: Vec::new(),
            files: Vec::new(),
            quick: None,
        }
    }
}

pub fn state_path() -> PathBuf {
    config_dir().join("gpui-tabs.json")
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ElectronTabs {
    font_delta: Option<i32>,
    sidebar_hidden: Option<bool>,
    sidebar_width: Option<f32>,
    sidebar_view: Option<String>,
    collapsed_repos: Option<Vec<String>>,
}

impl UiState {
    pub fn load() -> UiState {
        if let Ok(text) = std::fs::read_to_string(state_path()) {
            return serde_json::from_str::<UiState>(&text).map(UiState::normalized).unwrap_or_default();
        }
        let Ok(text) = std::fs::read_to_string(config_dir().join("tabs.json")) else { return UiState::default() };
        let old: ElectronTabs = serde_json::from_str(&text).unwrap_or_default();
        let d = UiState::default();
        UiState {
            font_delta: old.font_delta.unwrap_or(d.font_delta),
            sidebar_hidden: old.sidebar_hidden.unwrap_or(d.sidebar_hidden),
            sidebar_width: old.sidebar_width.unwrap_or(d.sidebar_width),
            sidebar_view: old.sidebar_view.unwrap_or(d.sidebar_view),
            collapsed_repos: old.collapsed_repos.unwrap_or_default(),
            ..d
        }
        .normalized()
    }

    fn normalized(mut self) -> UiState {
        self.sidebar_width = self.sidebar_width.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
        if self.sidebar_view != "all" {
            self.sidebar_view = "draft".into();
        }
        self.closed.truncate(CLOSED_LIMIT);
        self
    }

    // 書きかけを読まれないよう、別名で書いてから置き換える
    pub fn save(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(config_dir())?;
        let body = serde_json::to_string_pretty(self).map_err(std::io::Error::other)? + "\n";
        let path = state_path();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(tmp, path)
    }

    pub fn push_closed(&mut self, tab: ClosedTab) {
        self.closed.retain(|c| *c != tab);
        self.closed.insert(0, tab);
        self.closed.truncate(CLOSED_LIMIT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 閉じたタブは新しい順に二十件まで() {
        let mut s = UiState::default();
        for i in 0..25 {
            s.push_closed(ClosedTab { cwd: PathBuf::from(format!("/tmp/{i}")), name: None, workspace: "default".into() });
        }
        assert_eq!(s.closed.len(), CLOSED_LIMIT);
        assert_eq!(s.closed[0].cwd, PathBuf::from("/tmp/24"));
    }

    #[test]
    fn 幅は範囲に収める() {
        let s = UiState { sidebar_width: 900.0, sidebar_view: "x".into(), ..UiState::default() }.normalized();
        assert_eq!(s.sidebar_width, SIDEBAR_MAX);
        assert_eq!(s.sidebar_view, "draft");
    }
}
