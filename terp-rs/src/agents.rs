// 手元に入っている AI エージェントの CLI を探す。ターミナルで打って動くものと揃えるため、ログインシェルの PATH から探す。
// 設定の agents に書いた値を同じ command の既定に重ね、書いた順を優先する。
use serde_json::Value;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

// (command, 表示名, 確認を飛ばす引数, 別名, 既定の引数, アイコンの名前)
const KNOWN: &[(&str, &str, &str, &[&str], &str, &str)] = &[
    ("claude", "Claude Code", "--dangerously-skip-permissions", &[], "", "claude"),
    ("codex", "Codex", "--dangerously-bypass-approvals-and-sandbox", &[], "", "codex"),
    ("gemini", "Gemini CLI", "--yolo", &[], "", "gemini"),
    ("opencode", "OpenCode", "", &[], "", "opencode"),
    ("cursor-agent", "Cursor Agent", "--yolo", &[], "", "cursor-agent"),
    ("copilot", "Copilot CLI", "--yolo", &[], "", "copilot"),
    ("aider", "Aider", "--yes-always", &[], "", ""),
    ("amp", "Amp", "--dangerously-allow-all", &[], "", "amp"),
    ("qwen", "Qwen Code", "--approval-mode yolo", &[], "", "qwen"),
    ("goose", "Goose", "", &[], "", "goose"),
    ("crush", "Crush", "--yolo", &[], "", ""),
    ("droid", "Droid", "--auto high", &[], "", ""),
    ("coderabbit", "CodeRabbit", "", &["cr"], "", ""),
    ("codebuddy", "CodeBuddy", "--dangerously-skip-permissions", &["cbc"], "", "codebuddy"),
    ("openclaude", "OpenClaude", "--dangerously-skip-permissions", &[], "", ""),
    ("qodercli", "Qoder CLI", "--dangerously-skip-permissions", &["qoder"], "", "qodercli"),
    ("qoderclicn", "Qoder CLI China", "--dangerously-skip-permissions", &["qodercn"], "", "qodercli"),
    ("agy", "Antigravity", "--dangerously-skip-permissions", &[], "", "agy"),
    ("traecli", "Trae", "--yolo", &[], "", "traecli"),
    ("kiro-cli", "Kiro", "--trust-all-tools", &[], "", "kiro-cli"),
    ("kimi", "Kimi", "--yolo", &["kimi-code"], "", "kimi"),
    ("vibe", "Mistral Vibe", "--agent auto-approve", &["mistral-vibe"], "", "vibe"),
    ("devin", "Devin", "--permission-mode bypass --respect-workspace-trust false", &[], "", "devin"),
    ("dsh-tui", "DeepSeek Harness", "", &["dst"], "", "dsh-tui"),
    ("muse", "Muse", "--yolo", &[], "", "muse"),
    ("grok", "Grok", "--permission-mode bypassPermissions", &[], "", "grok"),
    ("hermes", "Hermes", "--yolo", &[], "", "hermes"),
    ("cline", "Cline", "--auto-approve true", &[], "", "cline"),
    ("kilo", "Kilo Code", "", &[], "", "kilo"),
    ("command-code", "Command Code", "--yolo", &[], "", "command-code"),
    ("zcode", "ZCode", "--mode yolo", &[], "", "zcode"),
    ("mimo", "MiMo Code", "", &[], "", "mimo"),
    ("opencode2", "OpenCode 2", "", &[], "", "opencode"),
    ("cn", "Continue", "--allow \"*\"", &[], "", ""),
    ("acli", "Rovo Dev", "--yolo", &[], "rovodev run", ""),
    ("auggie", "Auggie", "", &[], "", ""),
    ("autohand", "Autohand", "--unrestricted", &[], "", ""),
    ("ante", "Ante", "--yolo", &[], "", ""),
    ("pi", "Pi", "", &[], "", ""),
    ("omp", "OMP", "", &[], "", ""),
    ("prime-agent", "Prime Agent", "", &[], "", ""),
    ("codebuff", "Codebuff", "", &[], "", ""),
    ("freebuff", "Freebuff", "", &[], "", ""),
    ("jcode", "Jcode", "", &[], "", ""),
    ("openclaw", "OpenClaw", "", &[], "", ""),
];

#[derive(Debug, Clone, PartialEq)]
pub struct Agent {
    pub command: String,
    pub label: String,
    pub args: String,
    pub bypass_args: String,
    pub path: Option<PathBuf>,
    pub alias: Option<String>,
    pub configured_path: Option<String>,
    pub hidden: bool,
    pub env: BTreeMap<String, String>,
    pub known: bool,
    pub icon: String,
}

// 既知のエージェントの既定の（表示名, 確認を飛ばす引数, いつも付ける引数）
pub fn defaults(command: &str) -> Option<(&'static str, &'static str, &'static str)> {
    KNOWN.iter().find(|k| k.0 == command).map(|k| (k.1, k.2, k.4))
}

impl Agent {
    pub fn found(&self) -> bool {
        self.path.is_some()
    }
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn detect(configured: &[Value], path_var: &str) -> Vec<Agent> {
    let dirs: Vec<&str> = path_var.split(':').filter(|d| !d.is_empty()).collect();
    let mut overrides: Vec<(String, serde_json::Map<String, Value>)> = Vec::new();
    for item in configured {
        let Some(map) = item.as_object() else { continue };
        let Some(command) = map.get("command").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) else { continue };
        match overrides.iter_mut().find(|(c, _)| c == command) {
            Some((_, existing)) => existing.extend(map.clone()),
            None => overrides.push((command.to_string(), map.clone())),
        }
    }
    let mut commands: Vec<String> = overrides.iter().map(|(c, _)| c.clone()).collect();
    for (command, ..) in KNOWN {
        if !commands.iter().any(|c| c == command) {
            commands.push(command.to_string());
        }
    }
    commands
        .into_iter()
        .map(|command| {
            let known = KNOWN.iter().find(|k| k.0 == command);
            let o = overrides.iter().find(|(c, _)| *c == command).map(|(_, m)| m.clone()).unwrap_or_default();
            let text = |key: &str| o.get(key).and_then(Value::as_str).map(String::from);
            let configured_path = text("path").filter(|p| !p.is_empty());
            let mut targets: Vec<String> = vec![command.clone()];
            if let Some(k) = known {
                targets.extend(k.3.iter().map(|a| a.to_string()));
            }
            let mut path = None;
            let mut alias = None;
            if let Some(p) = &configured_path {
                path = (Path::new(p).is_absolute() && is_executable(Path::new(p))).then(|| PathBuf::from(p));
            } else {
                for target in &targets {
                    let hit = if Path::new(target).is_absolute() {
                        is_executable(Path::new(target)).then(|| PathBuf::from(target))
                    } else {
                        dirs.iter().map(|d| Path::new(d).join(target)).find(|p| is_executable(p))
                    };
                    if let Some(hit) = hit {
                        if *target != command {
                            alias = Some(target.clone());
                        }
                        path = Some(hit);
                        break;
                    }
                }
            }
            let env = o
                .get("env")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter().filter(|(k, v)| valid_env_name(k) && v.is_string()).map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()
                })
                .unwrap_or_default();
            let base = Path::new(&command).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| command.clone());
            Agent {
                label: text("label").filter(|l| !l.is_empty()).or_else(|| known.map(|k| k.1.to_string())).unwrap_or(base),
                args: text("args").unwrap_or_else(|| known.map(|k| k.4.to_string()).unwrap_or_default()),
                bypass_args: text("bypassArgs").unwrap_or_else(|| known.map(|k| k.2.to_string()).unwrap_or_default()),
                path,
                alias,
                configured_path,
                hidden: o.get("hidden").and_then(Value::as_bool) == Some(true),
                env,
                known: known.is_some(),
                icon: known.map(|k| k.5.to_string()).filter(|i| !i.is_empty()).unwrap_or_default(),
                command,
            }
        })
        .collect()
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// シェルに打つ1行。args は書式を保つ。実行ファイルは記号を含むときだけ、環境変数の値は必ず引用する
pub fn command_line(agent: &Agent, bypass: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !agent.env.is_empty() {
        parts.push("env".into());
        parts.extend(agent.env.iter().map(|(k, v)| format!("{k}={}", quote(v))));
    }
    let file = agent.configured_path.clone().or_else(|| agent.alias.clone()).unwrap_or_else(|| agent.command.clone());
    let simple = file.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    parts.push(if simple { file } else { quote(&file) });
    if !agent.args.is_empty() {
        parts.push(agent.args.clone());
    }
    if bypass && !agent.bypass_args.is_empty() {
        parts.push(agent.bypass_args.clone());
    }
    parts.join(" ")
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserCommand {
    pub label: String,
    pub command: String,
}

// 手で書いた誤った項目は飛ばす
pub fn user_commands(values: &[Value]) -> Vec<UserCommand> {
    values
        .iter()
        .filter_map(|v| {
            let label = v.get("label")?.as_str()?.trim().to_string();
            let command = v.get("command")?.as_str()?.trim().to_string();
            (!label.is_empty() && !command.is_empty()).then_some(UserCommand { label, command })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 設定の値を既定に重ねて先に並べる() {
        let list = detect(&[json!({"command": "codex", "label": "コーデックス"}), json!({"command": "mytool"})], "");
        assert_eq!(list[0].command, "codex");
        assert_eq!(list[0].label, "コーデックス");
        assert_eq!(list[0].bypass_args, "--dangerously-bypass-approvals-and-sandbox");
        assert_eq!(list[1].command, "mytool");
        assert!(!list[1].known);
        assert!(list.iter().any(|a| a.command == "claude"));
    }

    #[test]
    fn 起動の一行() {
        let mut a = detect(&[], "").into_iter().find(|a| a.command == "acli").unwrap();
        assert_eq!(command_line(&a, true), "acli rovodev run --yolo");
        a.env.insert("A_B".into(), "x y".into());
        a.configured_path = Some("/opt/my tools/acli".into());
        assert_eq!(command_line(&a, false), "env A_B='x y' '/opt/my tools/acli' rovodev run");
    }

    #[test]
    fn 誤ったコマンドの項目は飛ばす() {
        let list = user_commands(&[json!({"label": "テスト", "command": "npm test"}), json!({"label": ""}), json!(3)]);
        assert_eq!(list, vec![UserCommand { label: "テスト".into(), command: "npm test".into() }]);
    }
}
