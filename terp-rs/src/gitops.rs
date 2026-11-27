// 右の「変更」と「履歴」の面で使う git の操作。認証は持たず、ログインシェルの環境で git を呼ぶ。
use crate::git::{git, git_with};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DIFF_LINE_LIMIT: usize = 5000;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
const COMMIT_DIFF_LIMIT: usize = 12000;

pub fn toplevel(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    git(&["rev-parse", "--show-toplevel"], dir).ok().map(|o| PathBuf::from(o.trim()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub path: String,
    pub from: Option<String>,
    // M A D R C U ?
    pub code: char,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Status {
    pub top: PathBuf,
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub oid: String,
    pub staged: Vec<Change>,
    pub unstaged: Vec<Change>,
    pub conflicted: Vec<Change>,
    pub identity: (String, String),
}

pub fn parse_status(out: &str) -> Status {
    let mut st = Status::default();
    let parts: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let line = parts[i];
        i += 1;
        if line.is_empty() {
            continue;
        }
        if let Some(v) = line.strip_prefix("# branch.head ") {
            st.branch = v.to_string();
        } else if let Some(v) = line.strip_prefix("# branch.oid ") {
            st.oid = v.to_string();
        } else if let Some(v) = line.strip_prefix("# branch.upstream ") {
            st.upstream = v.to_string();
        } else if let Some(v) = line.strip_prefix("# branch.ab ") {
            let mut it = v.split_whitespace();
            st.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            st.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if line.starts_with('1') || line.starts_with('2') {
            let fields: Vec<&str> = line.split(' ').collect();
            let xy: Vec<char> = fields.get(1).unwrap_or(&"..").chars().collect();
            let skip = if line.starts_with('1') { 8 } else { 9 };
            let file = fields.get(skip..).map(|f| f.join(" ")).unwrap_or_default();
            let from = if line.starts_with('2') {
                let f = parts.get(i).map(|s| s.to_string());
                i += 1;
                f
            } else {
                None
            };
            if xy.first() != Some(&'.') {
                st.staged.push(Change { path: file.clone(), from, code: xy[0] });
            }
            if xy.get(1) != Some(&'.') {
                st.unstaged.push(Change { path: file, from: None, code: *xy.get(1).unwrap_or(&'M') });
            }
        } else if line.starts_with('u') {
            st.conflicted.push(Change { path: line.split(' ').skip(10).collect::<Vec<_>>().join(" "), from: None, code: 'U' });
        } else if let Some(file) = line.strip_prefix("? ") {
            st.unstaged.push(Change { path: file.to_string(), from: None, code: '?' });
        }
    }
    st
}

pub fn status(dir: &Path) -> Option<Status> {
    let top = toplevel(dir)?;
    let out = git(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], &top).ok()?;
    let mut st = parse_status(&out);
    let name = git(&["config", "user.name"], &top).map(|s| s.trim().to_string()).unwrap_or_default();
    let email = git(&["config", "user.email"], &top).map(|s| s.trim().to_string()).unwrap_or_default();
    st.identity = (name, email);
    st.top = top;
    Some(st)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Diff {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

fn limit(out: String) -> Diff {
    let binary = out.lines().any(|l| l.starts_with("Binary files "));
    let lines: Vec<&str> = out.lines().collect();
    let truncated = lines.len() > DIFF_LINE_LIMIT;
    Diff { text: lines[..lines.len().min(DIFF_LINE_LIMIT)].join("\n"), truncated, binary }
}

// kind: staged / unstaged / untracked
pub fn diff(top: &Path, file: &str, kind: &str) -> Diff {
    let out = if kind == "untracked" {
        // 追跡外は /dev/null との差。差があると git は 1 で終わる
        let mut cmd = std::process::Command::new("git");
        cmd.args(["diff", "--no-color", "--no-index", "--", "/dev/null", file]).current_dir(top).env_clear().envs(crate::git::login_env());
        crate::git::run_with_timeout(&mut cmd, None, Duration::from_secs(20)).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
    } else {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
        if kind == "staged" {
            args.push("--cached");
        }
        args.extend(["--", file]);
        git(&args, top).unwrap_or_default()
    };
    limit(out)
}

fn has_head(top: &Path) -> bool {
    git(&["rev-parse", "--verify", "--quiet", "HEAD"], top).is_ok()
}

pub fn stage(top: &Path, files: &[String]) -> anyhow::Result<()> {
    let mut args = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    git(&args, top).map(|_| ())
}

pub fn unstage(top: &Path, files: &[String]) -> anyhow::Result<()> {
    let mut args: Vec<&str> = if has_head(top) { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "--quiet", "--"] };
    args.extend(files.iter().map(String::as_str));
    git(&args, top).map(|_| ())
}

// ステージしていない変更を捨てる。今の中身は控えのフォルダに写してゴミ箱へ。追跡外のファイルはそのものをゴミ箱へ
pub fn discard(top: &Path, files: &[String]) -> anyhow::Result<()> {
    let st = status(top).ok_or_else(|| anyhow::anyhow!("リポジトリが見つかりません"))?;
    for file in files {
        let full = top.join(file);
        if !full.starts_with(top) || full == top || file.contains("..") {
            anyhow::bail!("リポジトリの外のファイルは取り消せません: {file}");
        }
        if !st.unstaged.iter().any(|c| c.path == *file) {
            anyhow::bail!("未ステージの変更がありません: {file}");
        }
    }
    let untracked: Vec<&String> = files.iter().filter(|f| st.unstaged.iter().any(|c| c.path == **f && c.code == '?')).collect();
    let tracked: Vec<&String> = files.iter().filter(|f| !untracked.contains(f)).collect();
    if !tracked.is_empty() {
        let kept: Vec<&&String> = tracked.iter().filter(|f| top.join(f.as_str()).exists()).collect();
        if !kept.is_empty() {
            let now = {
                unsafe {
                    let t = libc::time(std::ptr::null_mut());
                    let mut tm: libc::tm = std::mem::zeroed();
                    libc::localtime_r(&t, &mut tm);
                    format!("{}-{:02}-{:02} {:02}.{:02}.{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
                }
            };
            let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let base = std::env::temp_dir().join(format!("terp-discard-{}", std::process::id()));
            let backup = base.join(format!("{name} の取り消し前 {now}"));
            for f in kept {
                let dest = backup.join(f.as_str());
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(top.join(f.as_str()), dest)?;
            }
            crate::dock::trash(&backup)?;
        }
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked.iter().map(|s| s.as_str()));
        git(&args, top)?;
    }
    for f in untracked {
        crate::dock::trash(&top.join(f))?;
    }
    Ok(())
}

pub fn commit(top: &Path, message: &str) -> anyhow::Result<String> {
    git_with(&["commit", "--file=-"], top, Some(message.as_bytes()), NETWORK_TIMEOUT)
}

pub fn push(top: &Path) -> anyhow::Result<String> {
    let upstream = status(top).map(|s| s.upstream).unwrap_or_default();
    let args: &[&str] = if upstream.is_empty() { &["push", "--set-upstream", "origin", "HEAD"] } else { &["push"] };
    git_with(args, top, None, NETWORK_TIMEOUT)
}

pub fn pull(top: &Path) -> anyhow::Result<String> {
    git_with(&["pull", "--ff-only"], top, None, NETWORK_TIMEOUT)
}

pub fn fetch(top: &Path) -> anyhow::Result<String> {
    git_with(&["fetch", "--prune"], top, None, NETWORK_TIMEOUT)
}

pub fn staged_summary(top: &Path) -> (String, String, Vec<String>) {
    let stat = git(&["diff", "--cached", "--stat"], top).unwrap_or_default().trim().to_string();
    let full = git(&["diff", "--cached", "--no-color", "--no-ext-diff"], top).unwrap_or_default();
    let diff = if full.len() > COMMIT_DIFF_LIMIT {
        let mut cut = COMMIT_DIFF_LIMIT;
        while !full.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n（以下略）", &full[..cut])
    } else {
        full
    };
    let subjects = git(&["log", "-8", "--format=%s"], top).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    (stat, diff, subjects)
}

// ---- 履歴 ----

#[derive(Debug, Clone, PartialEq)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub refs: String,
    pub subject: String,
    pub body: String,
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let f: Vec<&str> = rec.trim_end_matches(['\0', '\n']).split('\u{1f}').collect();
            if f.len() < 8 {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                parents: f[2].split_whitespace().map(String::from).collect(),
                author: f[3].to_string(),
                date: f[4].to_string(),
                refs: f[5].to_string(),
                subject: f[6].to_string(),
                body: f[7].trim().to_string(),
            })
        })
        .collect()
}

// all なら全ブランチ。query は 4〜40桁の16進ならハッシュ、ほかは件名と作者。file はそのパスだけ
pub fn log(top: &Path, all: bool, skip: usize, query: &str, file: Option<&str>) -> Vec<Commit> {
    let format = "--format=%x1e%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b%x00";
    let q = query.trim();
    if (4..=40).contains(&q.len()) && q.chars().all(|c| c.is_ascii_hexdigit())
        && let Ok(hash) = git(&["rev-parse", "--verify", &format!("{q}^{{commit}}")], top)
    {
        return parse_log(&git(&["log", "-1", format, hash.trim()], top).unwrap_or_default());
    }
    let skip_arg = format!("--skip={skip}");
    let mut args: Vec<String> = vec!["log".into(), "--topo-order".into(), format.into(), "-n".into(), "100".into(), skip_arg];
    if all {
        args.push("--all".into());
    }
    if !q.is_empty() {
        args.push(format!("--grep={q}"));
        args.push(format!("--author={q}"));
        args.push("-i".into());
    }
    if let Some(file) = file {
        args.push("--".into());
        args.push(file.into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    parse_log(&git(&refs, top).unwrap_or_default())
}

// 未プッシュのコミット
pub fn unpushed(top: &Path) -> Vec<String> {
    git(&["rev-list", "@{u}..HEAD"], top).map(|o| o.lines().map(String::from).collect()).unwrap_or_default()
}

pub fn head_commits(top: &Path) -> std::collections::HashSet<String> {
    git(&["rev-list", "HEAD", "-n", "2000"], top).map(|o| o.lines().map(String::from).collect()).unwrap_or_default()
}

// 枝の線の列。各コミットの列と、その行で通っている列
#[derive(Debug, Clone, PartialEq)]
pub struct GraphRow {
    pub column: usize,
    pub lanes: Vec<bool>,
    pub merge: bool,
}

pub fn graph(commits: &[Commit]) -> Vec<GraphRow> {
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows = Vec::new();
    for c in commits {
        let column = match lanes.iter().position(|l| l.as_deref() == Some(c.hash.as_str())) {
            Some(i) => i,
            None => match lanes.iter().position(Option::is_none) {
                Some(i) => i,
                None => {
                    lanes.push(None);
                    lanes.len() - 1
                }
            },
        };
        // 同じコミットを待つ別の列は合流する
        for (i, l) in lanes.iter_mut().enumerate() {
            if i != column && l.as_deref() == Some(c.hash.as_str()) {
                *l = None;
            }
        }
        let active: Vec<bool> = lanes.iter().enumerate().map(|(i, l)| l.is_some() || i == column).collect();
        lanes[column] = c.parents.first().cloned();
        for p in c.parents.iter().skip(1) {
            if !lanes.iter().any(|l| l.as_deref() == Some(p.as_str())) {
                match lanes.iter().position(Option::is_none) {
                    Some(i) => lanes[i] = Some(p.clone()),
                    None => lanes.push(Some(p.clone())),
                }
            }
        }
        while lanes.last().is_some_and(Option::is_none) {
            lanes.pop();
        }
        rows.push(GraphRow { column: column.min(7), lanes: active.into_iter().take(8).collect(), merge: c.parents.len() > 1 });
    }
    rows
}

pub fn show(top: &Path, hash: &str) -> Option<(Commit, Vec<Change>)> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.len() < 4 {
        return None;
    }
    let out = git(&["show", "-s", "--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00%D%x00%s%x00%B", hash], top).ok()?;
    let f: Vec<&str> = out.split('\0').collect();
    if f.len() < 10 {
        return None;
    }
    let commit = Commit {
        hash: f[0].to_string(),
        short: f[1].to_string(),
        parents: f[2].split_whitespace().map(String::from).collect(),
        author: f[3].to_string(),
        date: f[4].to_string(),
        refs: f[7].to_string(),
        subject: f[8].to_string(),
        body: f[9].trim().to_string(),
    };
    // マージは最初の親との差、最初のコミットは空のツリーとの差
    let base = commit.parents.first().cloned().unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into());
    let names = git(&["diff-tree", "-r", "-M", "--no-commit-id", "--name-status", "-z", &base, &commit.hash], top).unwrap_or_default();
    let parts: Vec<&str> = names.split('\0').filter(|s| !s.is_empty()).collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let code = parts[i].chars().next().unwrap_or('M');
        if (code == 'R' || code == 'C') && i + 2 < parts.len() + 1 {
            files.push(Change { path: parts.get(i + 2).unwrap_or(&"").to_string(), from: parts.get(i + 1).map(|s| s.to_string()), code });
            i += 3;
        } else {
            files.push(Change { path: parts.get(i + 1).unwrap_or(&"").to_string(), from: None, code });
            i += 2;
        }
    }
    Some((commit, files))
}

pub fn commit_file_diff(top: &Path, commit: &Commit, file: &str) -> Diff {
    let base = commit.parents.first().cloned().unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into());
    limit(git(&["diff", "--no-color", "--no-ext-diff", &base, &commit.hash, "--", file], top).unwrap_or_default())
}

// 「たった今」「n分前」「n時間前」「n日前」
pub fn ago(iso: &str) -> String {
    let Some(t) = parse_iso(iso) else { return String::new() };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let s = (now - t).max(0);
    match s {
        0..60 => "たった今".into(),
        60..3600 => format!("{}分前", s / 60),
        3600..86400 => format!("{}時間前", s / 3600),
        _ => format!("{}日前", s / 86400),
    }
}

// 2026-11-25T10:00:00+09:00 を秒に
fn parse_iso(t: &str) -> Option<i64> {
    let (date, rest) = t.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (time, offset) = match rest.find(['+', '-', 'Z']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let mut p = time.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (p.next()??, p.next()??, p.next().flatten().unwrap_or(0));
    let off = if offset.len() >= 6 {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        sign * (offset[1..3].parse::<i64>().ok()? * 3600 + offset[4..6].parse::<i64>().ok()? * 60)
    } else {
        0
    };
    let (yy, mo) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * mo + 2) / 5 + day - 1;
    Some((era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss - off)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 状態を読む() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\01 M. N... 100644 100644 100644 a b src/a.rs\01 .M N... 100644 100644 100644 a b src/b.rs\0? new.txt\0";
        let st = parse_status(out);
        assert_eq!((st.branch.as_str(), st.ahead, st.behind), ("main", 2, 1));
        assert_eq!(st.staged, vec![Change { path: "src/a.rs".into(), from: None, code: 'M' }]);
        assert_eq!(st.unstaged.len(), 2);
        assert_eq!(st.unstaged[1].code, '?');
    }

    #[test]
    fn 枝の列を組む() {
        let c = |h: &str, p: &[&str]| Commit {
            hash: h.into(),
            short: h.into(),
            parents: p.iter().map(|s| s.to_string()).collect(),
            author: String::new(),
            date: String::new(),
            refs: String::new(),
            subject: String::new(),
            body: String::new(),
        };
        let commits = vec![c("m", &["a", "b"]), c("b", &["a"]), c("a", &[])];
        let g = graph(&commits);
        assert_eq!(g[0].column, 0);
        assert!(g[0].merge);
        assert_eq!(g[1].column, 1);
        assert_eq!(g[2].column, 0);
    }

    #[test]
    fn 時刻を読む() {
        assert_eq!(parse_iso("1970-01-01T09:00:00+09:00"), Some(0));
    }
}

#[cfg(test)]
mod probe {
    // このリポジトリで実際に読む（手で確かめるときだけ動かす）
    #[test]
    #[ignore]
    fn このリポジトリを読む() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let st = super::status(here).unwrap();
        println!("branch={} upstream={} staged={} unstaged={}", st.branch, st.upstream, st.staged.len(), st.unstaged.len());
        let log = super::log(&st.top, false, 0, "", None);
        let g = super::graph(&log);
        println!("log={} first={:?} col={}", log.len(), log.first().map(|c| &c.subject), g.first().map(|r| r.column).unwrap_or(9));
        let (c, files) = super::show(&st.top, &log[0].hash).unwrap();
        println!("show={} files={}", c.short, files.len());
    }
}
