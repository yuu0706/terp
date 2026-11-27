// 常駐のプロセスごと消えたとき（Mac の再起動など）に開き直すための控え（~/.config/terp/gpui-sessions.json）と、
// エージェントの会話の履歴（~/.config/terp/agent-history.json。Electron 版と共有し、同じ会話は1件にまとめる）。
use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const HISTORY_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    // 常駐のプロセスでのシェルの番号。枠の配置を戻すのに使う
    pub id: Option<u64>,
    pub cwd: PathBuf,
    pub workspace: String,
    pub custom_name: Option<String>,
    pub agent_title: Option<String>,
    pub work_path: Option<PathBuf>,
    pub agent: Option<String>,
    pub agent_session: Option<String>,
    pub config_dir: Option<PathBuf>,
    pub bypass: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct File {
    saved_at: String,
    sessions: Vec<Saved>,
}

pub fn path() -> PathBuf {
    config_dir().join("gpui-sessions.json")
}

pub fn load() -> Vec<Saved> {
    std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str::<File>(&t).ok()).map(|f| f.sessions).unwrap_or_default()
}

fn write_atomic(path: &Path, body: String) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, path)
}

pub fn save(sessions: &[Saved]) -> std::io::Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = File { saved_at: now.to_string(), sessions: sessions.to_vec() };
    write_atomic(&path(), serde_json::to_string_pretty(&file).map_err(std::io::Error::other)? + "\n")
}

// codex の記録の名前（rollout-<日時>-<UUID>.jsonl）から会話の ID を取る
pub fn codex_id(file: &Path) -> Option<String> {
    let name = file.file_name()?.to_string_lossy().into_owned();
    let stem = name.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    valid_session_id(id).then(|| id.to_string())
}

pub fn valid_session_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// 開き直すときに打つ1行。claude は --resume、codex は resume。設定のフォルダが別なら CLAUDE_CONFIG_DIR を前に付ける
pub fn resume_line(saved: &Saved, agents: &[crate::agents::Agent]) -> Option<String> {
    let agent_name = saved.agent.as_deref()?;
    let id = saved.agent_session.as_deref().filter(|i| valid_session_id(i))?;
    let agent = agents.iter().find(|a| a.command == agent_name)?;
    let mut base = crate::agents::command_line(&crate::agents::Agent { bypass_args: String::new(), ..agent.clone() }, false);
    base = match agent_name {
        "claude" => format!("{base} --resume {id}"),
        "codex" => format!("{base} resume {id}"),
        _ => return None,
    };
    if saved.bypass && !agent.bypass_args.is_empty() {
        base = format!("{base} {}", agent.bypass_args);
    }
    if let Some(dir) = &saved.config_dir {
        base = format!("env CLAUDE_CONFIG_DIR={} {base}", quote(&dir.display().to_string()));
    }
    Some(base)
}

// ---- 会話の履歴 ----

pub fn history_path() -> PathBuf {
    config_dir().join("agent-history.json")
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub agent: String,
    pub session_id: String,
    pub cwd: PathBuf,
    pub workspace: Option<String>,
    pub title: String,
    pub name: String,
    pub config_dir: Option<PathBuf>,
    pub last_used: i64,
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| s.trim().chars().take(300).collect()).unwrap_or_default()
}

pub fn load_history() -> Vec<HistoryEntry> {
    let Ok(t) = std::fs::read_to_string(history_path()) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&t) else { return Vec::new() };
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let agent = e.get("agent")?.as_str()?.to_string();
            let session_id = e.get("sessionId")?.as_str()?.to_string();
            let cwd = PathBuf::from(e.get("cwd")?.as_str()?);
            (["claude", "codex"].contains(&agent.as_str()) && valid_session_id(&session_id) && cwd.is_absolute()).then(|| HistoryEntry {
                agent,
                session_id,
                cwd,
                workspace: Some(text(e.get("workspace"))).filter(|w| !w.is_empty()),
                title: text(e.get("title")),
                name: text(e.get("name")),
                config_dir: e.get("configDir").and_then(Value::as_str).map(PathBuf::from).filter(|p| p.is_absolute()),
                last_used: e.get("lastUsed").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

// 動いている会話を足す。同じ会話は1件、題名が空なら前を残す。Electron 版の項目（startedAt など）は残す
pub fn record_history(seen: &[Saved], now_ms: i64) -> std::io::Result<()> {
    let fresh: Vec<&Saved> = seen
        .iter()
        .filter(|s| s.agent.as_deref().is_some_and(|a| a == "claude" || a == "codex"))
        .filter(|s| s.agent_session.as_deref().is_some_and(valid_session_id))
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }
    let mut root: Value = std::fs::read_to_string(history_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if !root.get("entries").is_some_and(Value::is_array) {
        root = serde_json::json!({ "entries": [] });
    }
    let entries = root.get_mut("entries").and_then(Value::as_array_mut).expect("配列にした");
    for s in fresh {
        let (agent, sid) = (s.agent.clone().unwrap_or_default(), s.agent_session.clone().unwrap_or_default());
        let title = s.agent_title.clone().unwrap_or_default();
        let name = s.custom_name.clone().unwrap_or_default();
        let found = entries.iter_mut().find(|e| {
            e.get("agent").and_then(Value::as_str) == Some(agent.as_str()) && e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str())
        });
        match found {
            Some(Value::Object(e)) => {
                e.insert("cwd".into(), Value::String(s.cwd.display().to_string()));
                e.insert("workspace".into(), Value::String(s.workspace.clone()));
                if !title.is_empty() {
                    e.insert("title".into(), Value::String(title));
                }
                if !name.is_empty() {
                    e.insert("name".into(), Value::String(name));
                }
                e.insert("lastUsed".into(), Value::from(now_ms));
            }
            _ => entries.push(serde_json::json!({
                "agent": agent, "sessionId": sid, "cwd": s.cwd.display().to_string(), "workspace": s.workspace,
                "title": title, "name": name, "configDir": s.config_dir.as_ref().map(|d| d.display().to_string()),
                "startedAt": now_ms, "lastUsed": now_ms,
            })),
        }
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.get("lastUsed").and_then(Value::as_i64).unwrap_or(0)));
    entries.truncate(HISTORY_LIMIT);
    write_atomic(&history_path(), serde_json::to_string_pretty(&root).map_err(std::io::Error::other)? + "\n")
}

// 履歴から外す（記録そのものは消さない）
pub fn forget_history(agent: &str, session_id: &str) -> std::io::Result<()> {
    let mut root: Value = std::fs::read_to_string(history_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if let Some(entries) = root.get_mut("entries").and_then(Value::as_array_mut) {
        entries.retain(|e| !(e.get("agent").and_then(Value::as_str) == Some(agent) && e.get("sessionId").and_then(Value::as_str) == Some(session_id)));
        write_atomic(&history_path(), serde_json::to_string_pretty(&root).map_err(std::io::Error::other)? + "\n")?;
    }
    Ok(())
}

// 「たった今」「n分前」「HH:MM」「昨日 HH:MM」「M/D」
pub fn history_time(at_ms: i64, now_ms: i64) -> String {
    if at_ms <= 0 {
        return String::new();
    }
    let minutes = (now_ms - at_ms) / 60000;
    if minutes < 1 {
        return "たった今".into();
    }
    if minutes < 60 {
        return format!("{minutes}分前");
    }
    let local = |ms: i64| {
        let secs = ms / 1000 + local_offset();
        (secs.div_euclid(86400), (secs.rem_euclid(86400) / 3600, secs.rem_euclid(3600) / 60))
    };
    let (day, (h, m)) = local(at_ms);
    let (today, _) = local(now_ms);
    match today - day {
        0 => format!("{h}:{m:02}"),
        1 => format!("昨日 {h}:{m:02}"),
        _ => {
            let (y, mo, d) = civil(day);
            let (ty, _, _) = civil(today);
            if y == ty { format!("{mo}/{d}") } else { format!("{y}/{mo}/{d}") }
        }
    }
}

fn local_offset() -> i64 {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm.tm_gmtoff
    }
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_の記録の名前から会話の_id() {
        let f = Path::new("/x/rollout-2026-11-25T01-02-03-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl");
        assert_eq!(codex_id(f).as_deref(), Some("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
    }

    #[test]
    fn 開き直す一行() {
        let agents = crate::agents::detect(&[], "");
        let saved = Saved {
            agent: Some("claude".into()),
            agent_session: Some("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b".into()),
            bypass: true,
            config_dir: Some(PathBuf::from("/Users/x/.claude2")),
            ..Saved::default()
        };
        assert_eq!(
            resume_line(&saved, &agents).as_deref(),
            Some("env CLAUDE_CONFIG_DIR='/Users/x/.claude2' claude --resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b --dangerously-skip-permissions")
        );
        let codex = Saved { agent: Some("codex".into()), bypass: false, config_dir: None, ..saved };
        assert_eq!(resume_line(&codex, &agents).as_deref(), Some("codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
    }

    #[test]
    fn 経過の書き方() {
        let now = 1_800_000_000_000;
        assert_eq!(history_time(now - 30_000, now), "たった今");
        assert_eq!(history_time(now - 5 * 60_000, now), "5分前");
    }
}
