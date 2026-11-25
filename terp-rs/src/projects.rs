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

// 記録を読み、変えた所だけ書き戻す。Electron 版の項目（parked など）は読み込んだまま残す
pub fn update(change: impl FnOnce(&mut Map<String, Value>) -> anyhow::Result<()>) -> anyhow::Result<()> {
    let path = projects_path();
    let mut value: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let Value::Object(map) = &mut value else { anyhow::bail!("projects.json がオブジェクトでない") };
    // 旧形式はワークスペースを補ってから書く
    let normalized = Projects::normalize(&Value::Object(map.clone()));
    if !map.get("workspaces").is_some_and(Value::is_array) {
        map.insert(
            "workspaces".into(),
            Value::Array(normalized.workspaces.iter().map(|w| serde_json::json!({ "id": w.id, "name": w.name })).collect()),
        );
    }
    if !map.get("projects").is_some_and(Value::is_array) {
        map.insert("projects".into(), Value::Array(Vec::new()));
    }
    change(map)?;
    std::fs::create_dir_all(config_dir())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&value)? + "\n")?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn projects_mut(map: &mut Map<String, Value>) -> &mut Vec<Value> {
    map.entry("projects").or_insert_with(|| Value::Array(Vec::new())).as_array_mut().expect("配列にした")
}

fn workspaces_mut(map: &mut Map<String, Value>) -> &mut Vec<Value> {
    map.entry("workspaces").or_insert_with(|| Value::Array(Vec::new())).as_array_mut().expect("配列にした")
}

fn with_project(map: &mut Map<String, Value>, path: &str, f: impl FnOnce(&mut Map<String, Value>)) {
    if let Some(Value::Object(p)) = projects_mut(map).iter_mut().find(|p| p.get("path").and_then(Value::as_str) == Some(path)) {
        f(p);
    }
}

// 表示中のワークスペースだけを書き換える
pub fn save_active_workspace(id: &str) -> anyhow::Result<()> {
    update(|map| {
        map.insert("activeWorkspace".into(), Value::String(id.into()));
        Ok(())
    })
}

// ドラフトに出し入れする。外すときは閉じた端末の控え（parked）を残し、戻すときは消す
pub fn set_draft_parked(path: &str, draft: bool, parked: Vec<Value>) -> anyhow::Result<()> {
    update(|map| {
        with_project(map, path, |p| {
            p.insert("draft".into(), Value::Bool(draft));
            p.insert("parked".into(), Value::Array(if draft { Vec::new() } else { parked }));
        });
        Ok(())
    })
}

// ドラフトから外したときに閉じた端末の控え
pub fn parked(path: &str) -> Vec<Value> {
    let value: Value = std::fs::read_to_string(projects_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    value
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|p| p.get("path").and_then(Value::as_str) == Some(path)))
        .and_then(|p| p.get("parked"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}


// 既に登録したリポジトリなら、重ねずにそのワークスペースへ移してドラフトに出す
pub fn add_project(path: &str, workspace: &str) -> anyhow::Result<()> {
    update(|map| {
        let list = projects_mut(map);
        match list.iter_mut().find(|p| p.get("path").and_then(Value::as_str) == Some(path)) {
            Some(Value::Object(p)) => {
                p.insert("workspace".into(), Value::String(workspace.into()));
                p.insert("draft".into(), Value::Bool(true));
            }
            _ => list.push(serde_json::json!({ "path": path, "workspace": workspace, "draft": true })),
        }
        Ok(())
    })
}

pub fn remove_project(path: &str) -> anyhow::Result<()> {
    update(|map| {
        projects_mut(map).retain(|p| p.get("path").and_then(Value::as_str) != Some(path));
        Ok(())
    })
}

pub fn move_project(path: &str, workspace: &str) -> anyhow::Result<()> {
    update(|map| {
        with_project(map, path, |p| {
            p.insert("workspace".into(), Value::String(workspace.into()));
        });
        Ok(())
    })
}

// order に並べたリポジトリだけを、その順に入れ替える。ほかの位置は保つ
pub fn reorder(order: &[String]) -> anyhow::Result<()> {
    update(|map| {
        let list = projects_mut(map);
        let slots: Vec<usize> = list
            .iter()
            .enumerate()
            .filter(|(_, p)| p.get("path").and_then(Value::as_str).is_some_and(|x| order.iter().any(|o| o == x)))
            .map(|(i, _)| i)
            .collect();
        let mut moved: Vec<Value> = order
            .iter()
            .filter_map(|o| list.iter().find(|p| p.get("path").and_then(Value::as_str) == Some(o.as_str())).cloned())
            .collect();
        if moved.len() != slots.len() {
            return Ok(());
        }
        for (slot, value) in slots.into_iter().zip(moved.drain(..)) {
            list[slot] = value;
        }
        Ok(())
    })
}

pub fn create_workspace(name: &str) -> anyhow::Result<String> {
    let id = new_id();
    update(|map| {
        workspaces_mut(map).push(serde_json::json!({ "id": id, "name": name.trim() }));
        Ok(())
    })?;
    Ok(id)
}

pub fn rename_workspace(id: &str, name: &str) -> anyhow::Result<()> {
    update(|map| {
        if let Some(Value::Object(w)) = workspaces_mut(map).iter_mut().find(|w| w.get("id").and_then(Value::as_str) == Some(id)) {
            w.insert("name".into(), Value::String(name.trim().into()));
        }
        Ok(())
    })
}

// 最後の1つと、リポジトリがあるワークスペースは消さない（端末の有無は呼ぶ側で確かめる）
pub fn delete_workspace(id: &str) -> anyhow::Result<()> {
    update(|map| {
        if projects_mut(map).iter().any(|p| p.get("workspace").and_then(Value::as_str) == Some(id)) {
            anyhow::bail!("リポジトリかターミナルがあるため削除できない");
        }
        let list = workspaces_mut(map);
        if list.len() <= 1 {
            anyhow::bail!("最後のワークスペースは削除できない");
        }
        list.retain(|w| w.get("id").and_then(Value::as_str) != Some(id));
        if map.get("activeWorkspace").and_then(Value::as_str) == Some(id) {
            let first = workspaces_mut(map).first().and_then(|w| w.get("id")).cloned().unwrap_or(Value::Null);
            map.insert("activeWorkspace".into(), first);
        }
        Ok(())
    })
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut bytes);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
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
