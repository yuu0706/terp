// 一覧に出すリポジトリとワークスペースの記録（~/.config/terp/projects.json）。Electron 版と同じファイルを読み書きする。
use crate::config::config_dir;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const DEFAULT_WORKSPACE: &str = "default";

#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub path: String,
    pub workspace: String,
    pub draft: bool,
}

impl Project {
    pub fn name(&self) -> &str {
        Path::new(&self.path).file_name().and_then(|n| n.to_str()).unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Projects {
    pub workspaces: Vec<Workspace>,
    pub projects: Vec<Project>,
    pub active_workspace: String,
}

pub fn projects_path() -> PathBuf {
    config_dir().join("projects.json")
}

impl Projects {
    pub fn load() -> Projects {
        let value = std::fs::read_to_string(projects_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        Self::normalize(&value)
    }

    // 壊れた記録は捨て、ワークスペースが無ければ「既定」を作る
    pub fn normalize(value: &Value) -> Projects {
        let mut workspaces: Vec<Workspace> = Vec::new();
        for w in value.get("workspaces").and_then(Value::as_array).into_iter().flatten() {
            let id = w.get("id").and_then(Value::as_str).unwrap_or("");
            let name = w.get("name").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() || name.is_empty() || workspaces.iter().any(|x| x.id == id) {
                continue;
            }
            workspaces.push(Workspace { id: id.into(), name: name.into() });
        }
        if workspaces.is_empty() {
            workspaces.push(Workspace { id: DEFAULT_WORKSPACE.into(), name: "既定".into() });
        }
        let fallback = workspaces[0].id.clone();
        let valid = |id: Option<&str>| id.filter(|id| workspaces.iter().any(|w| w.id == *id)).map(String::from);
        let raw: Vec<&Value> = value.get("projects").and_then(Value::as_array).into_iter().flatten().collect();
        let any_favorite = raw.iter().any(|p| p.get("favorite") == Some(&Value::Bool(true)));
        let mut projects: Vec<Project> = Vec::new();
        for p in raw {
            let Some(path) = p.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
            if projects.iter().any(|x| x.path == path) {
                continue;
            }
            // 旧形式は、お気に入りがあればお気に入りを、無ければ隠していないものをドラフトとして読む
            let draft = match p.get("draft").and_then(Value::as_bool) {
                Some(draft) => draft,
                None if any_favorite => p.get("favorite") == Some(&Value::Bool(true)),
                None => p.get("hidden") != Some(&Value::Bool(true)),
            };
            projects.push(Project {
                path: path.into(),
                workspace: valid(p.get("workspace").and_then(Value::as_str)).unwrap_or_else(|| fallback.clone()),
                draft,
            });
        }
        let active_workspace = valid(value.get("activeWorkspace").and_then(Value::as_str)).unwrap_or(fallback);
        Projects { workspaces, projects, active_workspace }
    }
}

pub fn contains_path(root: &str, cwd: &str) -> bool {
    let root = root.trim_end_matches('/');
    cwd == root || cwd.starts_with(&format!("{root}/"))
}

// 表示中のワークスペースだけを書き換える。Electron 版の項目は読み込んだまま残す
pub fn save_active_workspace(id: &str) -> anyhow::Result<()> {
    let path = projects_path();
    let mut value: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let Value::Object(map) = &mut value else { anyhow::bail!("projects.json がオブジェクトでない") };
    map.insert("activeWorkspace".into(), Value::String(id.into()));
    std::fs::create_dir_all(config_dir())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&value)? + "\n")?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ワークスペースが無ければ既定を作る() {
        let p = Projects::normalize(&json!({}));
        assert_eq!(p.workspaces, vec![Workspace { id: "default".into(), name: "既定".into() }]);
        assert_eq!(p.active_workspace, "default");
    }

    #[test]
    fn 存在しないワークスペースのリポジトリは先頭へ寄せる() {
        let p = Projects::normalize(&json!({
            "workspaces": [{"id": "w1", "name": "仕事"}, {"id": "w2", "name": "個人"}],
            "projects": [{"path": "/a", "workspace": "gone"}, {"path": "/b", "workspace": "w2", "draft": false}, {"path": "/a"}],
            "activeWorkspace": "w2"
        }));
        assert_eq!(p.projects.len(), 2);
        assert_eq!(p.projects[0].workspace, "w1");
        assert!(p.projects[0].draft);
        assert!(!p.projects[1].draft);
        assert_eq!(p.active_workspace, "w2");
    }

    #[test]
    fn 旧形式のお気に入りをドラフトとして読む() {
        let p = Projects::normalize(&json!({"projects": [{"path": "/a", "favorite": true}, {"path": "/b"}]}));
        assert!(p.projects[0].draft);
        assert!(!p.projects[1].draft);
    }

    #[test]
    fn 作業場所がリポジトリの中かを判定する() {
        assert!(contains_path("/repo", "/repo"));
        assert!(contains_path("/repo/", "/repo/sub"));
        assert!(!contains_path("/repo", "/repository"));
    }
}
