// git の操作。worktree の一覧は毎回 git から読み、terp では持たない。
// 認証は terp で持たず、ターミナルで git を打ったときと同じもの（SSH の鍵・キーチェーン・gh の認証）を使う。
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MARK: &str = "__TERP_ENV__";

// Finder から起動すると PATH が細いため、ログインシェルが整える環境を一度だけ読む。読めなければ PATH だけ足す
pub fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let mut base: HashMap<String, String> = std::env::vars()
            .filter(|(k, _)| !(k.starts_with("ELECTRON_") || k.starts_with("npm_") || k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_")))
            .collect();
        let path = format!("{}:{FALLBACK_PATH}", base.get("PATH").cloned().unwrap_or_default());
        base.insert("PATH".into(), path);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = run_with_timeout(
            Command::new(shell).args(["-i", "-l", "-c", &format!("printf '{MARK}'; env -0")]).env_clear().envs(&base),
            None,
            Duration::from_secs(5),
        );
        let Ok(out) = out else { return base };
        let text = String::from_utf8_lossy(&out.stdout);
        let Some(at) = text.find(MARK) else { return base };
        let env: HashMap<String, String> = text[at + MARK.len()..]
            .split('\0')
            .filter_map(|entry| entry.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .filter(|(k, _)| !k.is_empty())
            .collect();
        if env.contains_key("PATH") { env } else { base }
    })
}

pub struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub fn run_with_timeout(cmd: &mut Command, input: Option<&[u8]>, timeout: Duration) -> std::io::Result<Output> {
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(input);
    }
    let mut stdout = child.stdout.take().expect("標準出力をつないだ");
    let mut stderr = child.stderr.take().expect("標準エラーをつないだ");
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "時間内に終わらなかった"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(Output { status, stdout: out_thread.join().unwrap_or_default(), stderr: err_thread.join().unwrap_or_default() })
}

pub fn git_with(args: &[&str], dir: &Path, input: Option<&[u8]>, timeout: Duration) -> anyhow::Result<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir).env_clear().envs(login_env()).env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    let out = run_with_timeout(&mut cmd, input, timeout)?;
    if out.status != Some(0) {
        let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!(if message.is_empty() { format!("git {} が失敗した", args.first().unwrap_or(&"")) } else { message });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn git(args: &[&str], dir: &Path) -> anyhow::Result<String> {
    git_with(args, dir, None, Duration::from_secs(20))
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    pub head: String,
    pub detached: bool,
    pub main: bool,
    pub changes: usize,
}

impl Worktree {
    // 作業の行の名前。ブランチが無ければ「（ブランチなし）<head>」
    pub fn label(&self) -> String {
        if self.branch.is_empty() { format!("（ブランチなし）{}", self.head) } else { self.branch.clone() }
    }
}

pub fn parse_worktrees(text: &str) -> Vec<Worktree> {
    let mut list: Vec<Worktree> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            list.push(Worktree { path: PathBuf::from(path), ..Worktree::default() });
            continue;
        }
        let Some(cur) = list.last_mut() else { continue };
        if let Some(head) = line.strip_prefix("HEAD ") {
            cur.head = head.chars().take(7).collect();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            cur.branch = branch.trim_start_matches("refs/heads/").to_string();
        } else if line == "detached" {
            cur.detached = true;
        }
    }
    if let Some(first) = list.first_mut() {
        first.main = true;
    }
    list
}

pub fn list_worktrees(repo: &Path) -> anyhow::Result<Vec<Worktree>> {
    let mut list = parse_worktrees(&git(&["worktree", "list", "--porcelain"], repo)?);
    for w in &mut list {
        w.changes = change_count(&w.path);
    }
    Ok(list)
}

// 変更のあるファイルの数（追跡外のファイルを含む）
pub fn change_count(dir: &Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    git(&["status", "--porcelain=v1"], dir).map(|out| out.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0)
}

// worktree の中のどこを渡されても、元のリポジトリ（最初の worktree）の場所を返す
pub fn repo_root(dir: &Path) -> anyhow::Result<PathBuf> {
    let common = PathBuf::from(git(&["rev-parse", "--path-format=absolute", "--git-common-dir"], dir)?.trim());
    Ok(if common.file_name().is_some_and(|n| n == ".git") { common.parent().map(Path::to_path_buf).unwrap_or(common) } else { common })
}

// 新しい作業の元にするブランチの既定。origin の既定ブランチ、無ければ今のブランチ
pub fn default_base(repo: &Path) -> String {
    if let Ok(out) = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo) {
        return out.trim().to_string();
    }
    git(&["branch", "--show-current"], repo).map(|o| o.trim().to_string()).ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "HEAD".into())
}

pub fn worktree_path(repo: &Path, branch: &str) -> PathBuf {
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    repo.parent().unwrap_or(repo).join(format!("{name}.worktrees")).join(branch.replace('/', "-"))
}

// 同名のブランチがあればそれを、無ければ base から作る
pub fn add_worktree(repo: &Path, branch: &str, base: &str) -> anyhow::Result<PathBuf> {
    let dest = worktree_path(repo, branch);
    let dest_s = dest.display().to_string();
    let exists = git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], repo).is_ok();
    if exists {
        git(&["worktree", "add", &dest_s, branch], repo)?;
    } else {
        git(&["worktree", "add", "-b", branch, &dest_s, base], repo)?;
    }
    Ok(dest)
}

// 変更が残っている worktree は git が拒否する。--force は付けない
pub fn remove_worktree(repo: &Path, dir: &Path) -> anyhow::Result<()> {
    git(&["worktree", "remove", &dir.display().to_string()], repo)?;
    Ok(())
}

pub fn current_branch(dir: &Path) -> Option<String> {
    git(&["branch", "--show-current"], dir).ok().map(|b| b.trim().to_string()).filter(|b| !b.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_の一覧を読む() {
        let text = "worktree /r/app\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /r/app.worktrees/fix-a\nHEAD fedcba9876543210\ndetached\n";
        let list = parse_worktrees(text);
        assert_eq!(list.len(), 2);
        assert!(list[0].main && !list[1].main);
        assert_eq!(list[0].label(), "main");
        assert_eq!(list[1].label(), "（ブランチなし）fedcba9");
    }

    #[test]
    fn 作業の場所はリポジトリの隣の_worktrees_の下() {
        assert_eq!(worktree_path(Path::new("/r/app"), "feature/x"), PathBuf::from("/r/app.worktrees/feature-x"));
    }
}
