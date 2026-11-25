// 端末に出た URL とファイルのパスを見つけ、開き先を決める。⌘クリックか右クリックで開く。
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

// URL は先に読み飛ばし、パスの区切りと行・桁を1回の走査で読む
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(https?://[^\s"'`<>\[\]{}「」『』【】]+)|([^\s"'`<>\[\]{}():,;=「」『』【】（）。，]+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)| line (\d+))?"#)
        .expect("正しい正規表現")
});

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Url(String),
    // 見つける前の書き方。開くときに場所を決める
    Path { path: String, line: Option<u32>, column: Option<u32>, shorter: Vec<String> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    // 文字の位置（char の番号）
    pub start: usize,
    pub end: usize,
    pub target: Target,
}

pub fn find(text: &str) -> Vec<Found> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let char_at = |byte: usize| chars.iter().position(|(b, _)| *b == byte).unwrap_or(chars.len());
    let mut found = Vec::new();
    for caps in TOKEN.captures_iter(text) {
        let whole = caps.get(0).expect("全体");
        if let Some(url) = caps.get(1) {
            let url_text = url.as_str().trim_end_matches(['.', ',', ')', '、', '。']);
            found.push(Found {
                start: char_at(url.start()),
                end: char_at(url.start()) + url_text.chars().count(),
                target: Target::Url(url_text.to_string()),
            });
            continue;
        }
        let Some(raw) = caps.get(2) else { continue };
        if raw.as_str().starts_with("http://") || raw.as_str().starts_with("https://") {
            continue;
        }
        let path = raw.as_str().trim_end_matches('.');
        let dot = path.rfind('.');
        if path.is_empty() || (!path.contains('/') && !dot.is_some_and(|d| d > 0 && d < path.len() - 1)) {
            continue;
        }
        // ./ や ../ や / だけはよく出るため、リンクにしない
        if matches!(path, "." | ".." | "./" | "../" | "/" | "~" | "~/") {
            continue;
        }
        let num = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u32>().ok());
        let line = num(3).or(num(5)).or(num(7));
        let column = num(4).or(num(6));
        let end_byte = if line.is_some() { whole.end() } else { raw.start() + path.len() };
        found.push(Found {
            start: char_at(raw.start()),
            end: char_at(end_byte),
            target: Target::Path { path: path.to_string(), line, column, shorter: shorter_paths(path) },
        });
    }
    found
}

// 「app.jsを直した」のように、パスの直後に日本語が続くと区切れない。
// そのパスが無いときに試す短い候補（英数字から日本語へ変わる手前まで）を長い順に返す
fn shorter_paths(path: &str) -> Vec<String> {
    let chars: Vec<char> = path.chars().collect();
    let mut out = Vec::new();
    for i in (1..chars.len()).rev() {
        if !chars[i - 1].is_ascii() || chars[i].is_ascii() {
            continue;
        }
        let cut: String = chars[..i].iter().collect::<String>().trim_end_matches('.').to_string();
        let dot = cut.rfind('.');
        if cut.ends_with('/') || (!cut.contains('/') && !dot.is_some_and(|d| d > 0 && d < cut.len() - 1)) {
            continue;
        }
        out.push(cut);
    }
    out
}

fn absolute(path: &str, base: &Path) -> PathBuf {
    let joined = if path.starts_with('/') { PathBuf::from(path) } else { base.join(path) };
    let mut parts: Vec<String> = Vec::new();
    for part in joined.to_string_lossy().split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p.to_string()),
        }
    }
    PathBuf::from(format!("/{}", parts.join("/")))
}

// 実在の確かめは5秒使い回す
fn exists(path: &Path) -> Option<bool> {
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, (Instant, Option<bool>)>>> = LazyLock::new(Mutex::default);
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, value)) = cache.get(path)
        && at.elapsed() < Duration::from_secs(5)
    {
        return *value;
    }
    if cache.len() > 1024 {
        cache.clear();
    }
    let value = std::fs::metadata(path).ok().filter(|m| m.is_file() || m.is_dir()).map(|m| m.is_dir());
    cache.insert(path.to_path_buf(), (Instant::now(), value));
    value
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub path: PathBuf,
    pub directory: bool,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

// 相対のパスは端末の作業場所、次に作業（worktree）の一番上から探す。~/ はホーム
pub fn resolve(target: &Target, cwd: &Path, root: Option<&Path>, home: &Path) -> Option<Resolved> {
    let Target::Path { path, line, column, shorter } = target else { return None };
    for (i, option) in std::iter::once(path).chain(shorter.iter()).enumerate() {
        let expanded = match option.strip_prefix("~/") {
            Some(rest) => home.join(rest).display().to_string(),
            None => option.clone(),
        };
        let mut bases: Vec<&Path> = vec![cwd];
        if let Some(root) = root
            && root != cwd
        {
            bases.push(root);
        }
        for base in bases {
            let full = absolute(&expanded, base);
            if let Some(directory) = exists(&full) {
                let (line, column) = if i == 0 { (*line, *column) } else { (None, None) };
                return Some(Resolved { path: full, directory, line, column });
            }
        }
    }
    None
}

// 外部のエディタで開く。設定の editor は {file}・{line}・{col} を置き換える。
// 無ければ VS Code（code）があればその行へ、無ければ macOS の既定のアプリで開く
pub fn open_file(resolved: &Resolved, editor: &str, path_var: &str) {
    let file = resolved.path.display().to_string();
    let line = resolved.line.unwrap_or(1).to_string();
    let col = resolved.column.unwrap_or(1).to_string();
    let mut command = std::process::Command::new("/bin/sh");
    if !editor.trim().is_empty() {
        let quoted = |v: &str| format!("'{}'", v.replace('\'', "'\\''"));
        let line_cmd = editor.replace("{file}", &quoted(&file)).replace("{line}", &line).replace("{col}", &col);
        command.args(["-c", &line_cmd]);
    } else if path_var.split(':').any(|d| Path::new(d).join("code").is_file()) {
        command.args(["-c", "exec code -g \"$1\"", "sh", &format!("{file}:{line}:{col}")]);
    } else {
        command.args(["-c", "exec open \"$1\"", "sh", &file]);
    }
    command.env("PATH", path_var);
    let _ = command.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_と行付きのパスを拾う() {
        let found = find("see https://example.com/a?b=1. and src/app.rs:12:5 then");
        assert_eq!(found[0].target, Target::Url("https://example.com/a?b=1".into()));
        assert!(matches!(&found[1].target, Target::Path { path, line: Some(12), column: Some(5), .. } if path == "src/app.rs"));
        assert_eq!(found[1].start, 35);
    }

    #[test]
    fn 拡張子もスラッシュも無い語はパスにしない() {
        assert!(find("hello world ./ ..").is_empty());
        assert!(matches!(&find("README.md")[0].target, Target::Path { path, .. } if path == "README.md"));
    }

    #[test]
    fn 日本語が続くパスには短い候補を付ける() {
        let found = find("app.jsを直した");
        let Target::Path { shorter, .. } = &found[0].target else { panic!() };
        assert_eq!(shorter, &vec!["app.js".to_string()]);
    }

    #[test]
    fn 相対のパスを作業場所から解決する() {
        let dir = std::env::temp_dir().join(format!("terp-links-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "").unwrap();
        let t = &find("src/a.rs:3")[0].target;
        let r = resolve(t, &dir, None, Path::new("/")).unwrap();
        assert_eq!(r.path, absolute("src/a.rs", &dir));
        assert_eq!(r.line, Some(3));
        assert!(!r.directory);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
