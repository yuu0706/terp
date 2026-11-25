// エージェントの会話の記録を読む。シェルの下で動く claude・codex の会話を探し、
// 今していること・締めの返答・編集したファイル・サブエージェントを拾う。
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

pub const TAIL_BYTES: u64 = 256 * 1024;
pub const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub kind: Kind,
    pub id: Option<String>,
    pub config_dir: Option<PathBuf>,
    pub file: Option<PathBuf>,
}

fn home() -> PathBuf {
    crate::config::home_dir()
}

fn run(file: &str, args: &[&str]) -> String {
    let mut cmd = Command::new(file);
    cmd.args(args).env("LC_ALL", "C");
    crate::git::run_with_timeout(&mut cmd, None, Duration::from_secs(5))
        .ok()
        .filter(|o| o.status == Some(0))
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

pub struct Procs {
    pub parent: HashMap<i32, i32>,
    pub name: HashMap<i32, String>,
}

pub fn procs() -> Procs {
    let mut parent = HashMap::new();
    let mut name = HashMap::new();
    for line in run("/bin/ps", &["-A", "-o", "pid=,ppid=,comm="]).lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next().and_then(|p| p.parse().ok()), parts.next().and_then(|p| p.parse().ok())) else { continue };
        let comm: String = parts.collect::<Vec<_>>().join(" ");
        parent.insert(pid, ppid);
        name.insert(pid, Path::new(&comm).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(comm));
    }
    Procs { parent, name }
}

impl Procs {
    // pid の親をたどって、shells のどれかに行き着けばそのシェル
    pub fn shell_of(&self, mut pid: i32, shells: &HashSet<i32>) -> Option<i32> {
        for _ in 0..12 {
            if shells.contains(&pid) {
                return Some(pid);
            }
            pid = *self.parent.get(&pid)?;
            if pid <= 1 {
                return None;
            }
        }
        None
    }

    pub fn descendants_named(&self, shell: i32, names: &[&str]) -> Vec<i32> {
        let shells: HashSet<i32> = [shell].into();
        self.name
            .iter()
            .filter(|(_, n)| names.contains(&n.as_str()))
            .filter(|(pid, _)| self.parent.get(pid).and_then(|pp| self.shell_of(*pp, &shells)).is_some())
            .map(|(pid, _)| *pid)
            .collect()
    }
}

fn is_version_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

// シェルの pid ごとに、その下の claude の会話の ID と設定のフォルダ。
// claude agents --json は既定の設定のフォルダの会話しか出さないため、CLAUDE_CONFIG_DIR を使うものは控えから拾う
pub fn claude_sessions(shells: &HashSet<i32>, procs: &Procs) -> HashMap<i32, (String, Option<PathBuf>)> {
    let mut result = HashMap::new();
    let candidates = [home().join(".local/bin/claude"), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")];
    let Some(claude) = candidates.iter().find(|p| p.exists()) else { return result };
    if shells.is_empty() {
        return result;
    }
    let out = run(&claude.display().to_string(), &["agents", "--json"]);
    if let Ok(Value::Array(agents)) = serde_json::from_str::<Value>(&out) {
        for a in agents {
            if a.get("kind").and_then(Value::as_str) != Some("interactive") {
                continue;
            }
            let (Some(pid), Some(sid)) = (a.get("pid").and_then(Value::as_i64), a.get("sessionId").and_then(Value::as_str)) else { continue };
            if let Some(shell) = procs.shell_of(pid as i32, shells) {
                result.insert(shell, (sid.to_string(), None));
            }
        }
    }
    for (pid, name) in &procs.name {
        if name != "claude" && !is_version_name(name) {
            continue;
        }
        let Some(shell) = procs.parent.get(pid).and_then(|pp| procs.shell_of(*pp, shells)) else { continue };
        if result.contains_key(&shell) {
            continue;
        }
        let env = run("/bin/ps", &["eww", "-o", "command=", "-p", &pid.to_string()]);
        let Some(dir) = env.split_whitespace().find_map(|w| w.strip_prefix("CLAUDE_CONFIG_DIR=")).map(PathBuf::from).filter(|d| d.is_absolute())
        else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(dir.join("sessions").join(format!("{pid}.json"))) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(&text) else { continue };
        if data.get("pid").and_then(Value::as_i64) != Some(*pid as i64) || data.get("kind").and_then(Value::as_str) != Some("interactive") {
            continue;
        }
        if let Some(sid) = data.get("sessionId").and_then(Value::as_str) {
            result.insert(shell, (sid.to_string(), Some(dir)));
        }
    }
    result
}

fn project_roots(config_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = config_dir.map(|d| vec![d.join("projects")]).unwrap_or_default();
    for dir in [".claude", ".claude2"] {
        let root = home().join(dir).join("projects");
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// 記録の場所が根の外へ出ていないかを確かめる（シンボリックリンクで外へ出させない）
fn within(file: &Path, root: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(file).ok()?;
    let base = std::fs::canonicalize(root).ok()?;
    (real.starts_with(&base) && real != base).then_some(real)
}

pub fn claude_file(id: &str, config_dir: Option<&Path>) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    for root in project_roots(config_dir) {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir())
                && let Some(file) = within(&entry.path().join(format!("{id}.jsonl")), &root)
            {
                return Some(file);
            }
        }
    }
    None
}

// codex は、シェルの下の codex が開いている rollout の記録。開いていなければ直近5分に書かれたもの
pub fn codex_file(shell: i32, procs: &Procs) -> Option<PathBuf> {
    let pids = procs.descendants_named(shell, &["codex"]);
    if pids.is_empty() {
        return None;
    }
    let root = home().join(".codex").join("sessions");
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    for line in run("/usr/sbin/lsof", &["-a", "-p", &list, "-Fn"]).lines() {
        let Some(file) = line.strip_prefix('n') else { continue };
        let name = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with("rollout-") && name.ends_with(".jsonl")
            && let Some(checked) = within(Path::new(file), &root)
        {
            return Some(checked);
        }
    }
    None
}

// 会話の記録の末尾 limit バイトを行ごとの JSON にする。whole は先頭まで読めたか
pub fn tail_rows(file: &Path, limit: u64) -> (Vec<Value>, bool) {
    let Ok(mut f) = std::fs::File::open(file) else { return (Vec::new(), true) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(limit);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start.saturating_sub(if start > 0 { 1 } else { 0 }))).is_err() || f.take(limit + 1).read_to_end(&mut buf).is_err() {
        return (Vec::new(), true);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && buf.first() != Some(&b'\n') && !lines.is_empty() {
        lines.remove(0);
    }
    let rows = lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object).collect();
    (rows, start == 0)
}

fn is_sidechain(row: &Value) -> bool {
    row.get("isSidechain").and_then(Value::as_bool) == Some(true)
}

fn content(row: &Value) -> Option<&Vec<Value>> {
    row.get("message")?.get("content")?.as_array()
}

// 締めの返答。道具を使った応答では、最後の道具の結果より後の文
pub fn extract_reply(rows: &[Value], kind: Kind) -> (String, bool) {
    if kind == Kind::Codex {
        let row = rows.iter().rev().find(|r| {
            r.get("type").and_then(Value::as_str) == Some("event_msg") && r.pointer("/payload/type").and_then(Value::as_str) == Some("task_complete")
        });
        return (row.and_then(|r| r.pointer("/payload/last_agent_message")).and_then(Value::as_str).unwrap_or("").to_string(), row.is_some());
    }
    let Some(last_user) = rows.iter().rposition(|r| !is_sidechain(r) && r.get("type").and_then(Value::as_str) == Some("user")) else {
        return (String::new(), false);
    };
    let texts: Vec<String> = rows[last_user + 1..]
        .iter()
        .filter(|r| !is_sidechain(r) && r.get("type").and_then(Value::as_str) == Some("assistant"))
        .filter_map(content)
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str).map(String::from))
        .collect();
    (texts.join("\n"), true)
}

pub fn read_reply(file: &Path, kind: Kind) -> String {
    for limit in [TAIL_BYTES, MAX_BYTES] {
        let (rows, whole) = tail_rows(file, limit);
        let (text, found) = extract_reply(&rows, kind);
        if found || whole {
            return text;
        }
    }
    String::new()
}

// 通知の本文に向けて、Markdown の飾りを外し、300字で切る
pub fn format_reply(text: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?(?:```|$)").unwrap());
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)\n]*\)").unwrap());
    static HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s{0,3}#{1,6}\s+|\s+#+\s*$").unwrap());
    static LIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?").unwrap());
    static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*>\s?").unwrap());
    static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*\|?\s*:?-{3,}[^\n]*\|[^\n]*$").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let t = CODE.replace_all(text, "（コード）");
    let t = LINK.replace_all(&t, "$1");
    let t = HEAD.replace_all(&t, "");
    let t = LIST.replace_all(&t, "");
    let t = QUOTE.replace_all(&t, "");
    let t = RULE.replace_all(&t, "");
    let t = t.replace('|', " ").replace("**", "").replace("__", "").replace('`', "");
    let t: String = t.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = SPACE.replace_all(&t, " ").trim().to_string();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() > 300 { format!("{}…", chars[..300].iter().collect::<String>()) } else { t }
}

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

fn clip(text: &str, n: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = one.chars().collect();
    if chars.len() > n { format!("{}…", chars[..n].iter().collect::<String>()) } else { one }
}

fn base(p: Option<&str>) -> String {
    p.and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// 道具の呼び出しを、一覧の行に出す短い「今なにしてる」にする
pub fn describe_tool(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    let out = if EDIT_TOOLS.contains(&name) {
        format!("編集 {}", base(s("file_path").or(s("notebook_path"))))
    } else {
        match name {
            "Read" => format!("読む {}", base(s("file_path"))),
            "Bash" => format!("実行 {}", clip(s("description").or(s("command")).unwrap_or(""), 60)),
            "Grep" | "Glob" => format!("検索 {}", clip(s("pattern").unwrap_or(""), 40)),
            "Task" | "Agent" => format!("サブに頼む {}", clip(s("description").unwrap_or(""), 40)),
            "WebFetch" => format!("Web を読む {}", clip(s("url").unwrap_or(""), 40)),
            "WebSearch" => format!("Web で検索 {}", clip(s("query").unwrap_or(""), 40)),
            "TodoWrite" => {
                let doing = input
                    .get("todos")
                    .and_then(Value::as_array)
                    .and_then(|t| t.iter().find(|t| t.get("status").and_then(Value::as_str) == Some("in_progress")));
                match doing {
                    Some(t) => clip(t.get("activeForm").or(t.get("content")).and_then(Value::as_str).unwrap_or(""), 60),
                    None => "作業の一覧を更新".into(),
                }
            }
            _ => {
                let short = if let Some(rest) = name.strip_prefix("mcp__") { rest.rsplit("__").next().unwrap_or(rest) } else { name };
                clip(short, 40)
            }
        }
    };
    out.trim().to_string()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Activity {
    pub text: String,
    // 編集したファイルと時刻（新しい順、30件まで）
    pub edits: Vec<(PathBuf, i64)>,
}

fn timestamp(row: &Value) -> i64 {
    row.get("timestamp")
        .and_then(Value::as_str)
        .and_then(|t| chrono_like_parse(t))
        .unwrap_or(0)
}

// ISO 8601（2026-11-25T01:02:03.456Z）を秒にする。外部の時刻の部品を足さないため手で読む
fn chrono_like_parse(t: &str) -> Option<i64> {
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let mut parts = time.split(':');
    let (hh, mm) = (parts.next()?.parse::<i64>().ok()?, parts.next()?.parse::<i64>().ok()?);
    let ss = parts.next()?.split('.').next()?.parse::<i64>().ok()?;
    let (yy, mo) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mo + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

pub fn activity_of(rows: &[Value], kind: Kind) -> Activity {
    let mut text = String::new();
    let mut edits: Vec<(PathBuf, i64)> = Vec::new();
    let note = |file: &str, at: i64, edits: &mut Vec<(PathBuf, i64)>| {
        if Path::new(file).is_absolute() {
            edits.retain(|(p, _)| p != Path::new(file));
            edits.push((PathBuf::from(file), at));
        }
    };
    for row in rows {
        if kind == Kind::Codex {
            let p = row.get("payload");
            let ty = row.get("type").and_then(Value::as_str);
            let pty = p.and_then(|p| p.get("type")).and_then(Value::as_str);
            if ty == Some("event_msg") && pty == Some("patch_apply_begin") {
                if let Some(changes) = p.and_then(|p| p.get("changes")).and_then(Value::as_object) {
                    for file in changes.keys() {
                        note(file, timestamp(row), &mut edits);
                    }
                    text = format!("編集 {}", changes.keys().map(|k| base(Some(k))).collect::<Vec<_>>().join(", "));
                }
            } else if ty == Some("response_item") && pty == Some("function_call") {
                let args: Value = p.and_then(|p| p.get("arguments")).and_then(Value::as_str).and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
                let command = match args.get("command") {
                    Some(Value::Array(a)) => Some(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
                    Some(Value::String(c)) => Some(c.clone()),
                    _ => args.get("cmd").and_then(Value::as_str).map(String::from),
                };
                text = match command {
                    Some(c) if !c.is_empty() => format!("実行 {}", clip(&c, 60)),
                    _ => clip(p.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or(""), 40),
                };
            }
            continue;
        }
        if is_sidechain(row) || row.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        for block in content(row).into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            text = describe_tool(name, &input);
            if EDIT_TOOLS.contains(&name)
                && let Some(file) = input.get("file_path").or(input.get("notebook_path")).and_then(Value::as_str)
            {
                note(file, timestamp(row), &mut edits);
            }
        }
    }
    edits.reverse();
    edits.truncate(30);
    Activity { text, edits }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subagent {
    pub file: PathBuf,
    pub description: String,
    pub agent_type: String,
    pub running: bool,
    pub started: Option<SystemTime>,
    pub modified: SystemTime,
}

// <projects>/<任意>/<会話ID>/subagents/agent-<id>.meta.json と agent-<id>.jsonl を読む
pub fn subagents(session_id: &str, config_dir: Option<&Path>) -> Vec<Subagent> {
    if !valid_id(session_id) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for root in project_roots(config_dir) {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let dir = entry.path().join(session_id).join("subagents");
            let Ok(files) = std::fs::read_dir(&dir) else { continue };
            for file in files.flatten() {
                let path = file.path();
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if !(name.starts_with("agent-") && name.ends_with(".jsonl")) {
                    continue;
                }
                let Some(path) = within(&path, &root) else { continue };
                let meta: Value = std::fs::read_to_string(path.with_extension("meta.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or(Value::Null);
                let modified = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                let recent = modified.elapsed().map(|e| e < Duration::from_secs(600)).unwrap_or(true);
                let finished = meta.get("finished").and_then(Value::as_bool) == Some(true);
                let started = std::fs::metadata(&path).and_then(|m| m.created()).ok();
                out.push(Subagent {
                    description: meta.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                    agent_type: meta.get("agentType").and_then(Value::as_str).unwrap_or("").to_string(),
                    running: !finished && recent,
                    started,
                    modified,
                    file: path,
                });
            }
        }
    }
    out.sort_by(|a, b| b.started.cmp(&a.started).then(b.modified.cmp(&a.modified)));
    out
}

// 経過（「1分未満」「n分」「n時間」「n日」）
pub fn elapsed_label(since: SystemTime) -> String {
    let s = since.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    match s {
        0..60 => "1分未満".into(),
        60..3600 => format!("{}分", s / 60),
        3600..86400 => format!("{}時間", s / 3600),
        _ => format!("{}日", s / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 締めの返答は最後の利用者の発言より後の文() {
        let rows = vec![
            json!({"type": "user", "message": {"content": "直して"}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "調べます"}, {"type": "tool_use", "name": "Read", "input": {}}]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "直しました"}]}}),
        ];
        assert_eq!(extract_reply(&rows, Kind::Claude), ("直しました".to_string(), true));
    }

    #[test]
    fn 返答の飾りを外す() {
        assert_eq!(format_reply("## 結果\n- **済** `a.rs`\n```\ncode\n```"), "結果 済 a.rs （コード）");
    }

    #[test]
    fn 道具の呼び出しを短く言う() {
        assert_eq!(describe_tool("Edit", &json!({"file_path": "/r/src/app.rs"})), "編集 app.rs");
        assert_eq!(describe_tool("Bash", &json!({"command": "cargo test", "description": "テストを回す"})), "実行 テストを回す");
        assert_eq!(describe_tool("mcp__github__get_issue", &json!({})), "get_issue");
    }

    #[test]
    fn 編集したファイルを新しい順に拾う() {
        let rows = vec![
            json!({"type": "assistant", "timestamp": "2026-11-25T00:00:00Z", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "/a"}}]}}),
            json!({"type": "assistant", "timestamp": "2026-11-25T00:01:00Z", "message": {"content": [{"type": "tool_use", "name": "Write", "input": {"file_path": "/b"}}]}}),
        ];
        let a = activity_of(&rows, Kind::Claude);
        assert_eq!(a.text, "編集 b");
        assert_eq!(a.edits[0].0, PathBuf::from("/b"));
        assert_eq!(a.edits[1].1 + 60, a.edits[0].1);
    }

    #[test]
    fn 時刻を読む() {
        assert_eq!(chrono_like_parse("1970-01-02T00:00:01.5Z"), Some(86401));
    }
}

#[cfg(test)]
mod probe {
    // 手元の claude の会話を実際に探す（手で確かめるときだけ動かす）
    #[test]
    #[ignore]
    fn 手元の会話を探す() {
        let procs = super::procs();
        let shells: std::collections::HashSet<i32> =
            procs.name.iter().filter(|(_, n)| ["zsh", "-zsh", "bash"].contains(&n.as_str())).map(|(p, _)| *p).collect();
        let found = super::claude_sessions(&shells, &procs);
        println!("shells={} found={}", shells.len(), found.len());
        for (shell, (sid, dir)) in found.iter().take(3) {
            let file = super::claude_file(sid, dir.as_deref());
            let act = file.as_ref().map(|f| super::activity_of(&super::tail_rows(f, super::TAIL_BYTES).0, super::Kind::Claude).text);
            println!("shell {shell}: file={} activity={:?} subagents={}", file.is_some(), act, super::subagents(sid, dir.as_deref()).len());
        }
    }
}
