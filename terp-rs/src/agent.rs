// AI エージェント（claude・codex など）の状態。題名・通知・入出力の時刻から、考え中・許可待ち・終わったを決める。
use std::time::{Duration, Instant};

const BUSY: Duration = Duration::from_millis(2000);
const SHELLS: [&str; 6] = ["zsh", "bash", "fish", "sh", "login", "tcsh"];

pub fn is_agent(program: Option<&str>) -> bool {
    program.is_some_and(|p| !p.is_empty() && !SHELLS.contains(&p.trim_start_matches('-')))
}

// claude などが題名の前に付ける、作業中を表す回転の記号。✳ は入力待ち
fn is_working_mark(c: char) -> bool {
    matches!(c, '◐' | '◑' | '◒' | '◓' | '·' | '✢' | '✶' | '✻' | '✽' | '*') || ('\u{2801}'..='\u{28ff}').contains(&c)
}

const DEFAULT_TITLES: [&str; 4] = ["Claude Code", "Codex", "codex", "claude"];

#[derive(Debug, PartialEq, Eq)]
pub struct Title {
    pub working: bool,
    pub text: Option<String>,
}

// 端末のタイトル（OSC 0/2）を、先頭の記号と題名に分ける
pub fn parse_title(raw: &str) -> Title {
    let raw = raw.trim();
    let split = raw.char_indices().find(|(_, c)| c.is_alphanumeric()).map(|(i, _)| i).unwrap_or(raw.len());
    let (mark, text) = (raw[..split].trim(), raw[split..].trim());
    let working = mark.chars().next().is_some_and(is_working_mark) && mark != "✳";
    let text = (!text.is_empty() && !DEFAULT_TITLES.contains(&text)).then(|| text.to_string());
    Title { working, text }
}

pub fn permission_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["permission", "approv", "allow", "許可", "承認"].iter().any(|w| lower.contains(w))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Idle,
    Working,
    Waiting,
    Done,
}

#[derive(Debug, Clone, Default)]
pub struct AgentStatus {
    working: bool,
    waiting: bool,
    done: bool,
    last_output: Option<Instant>,
    output_since: Option<Instant>,
    last_input: Option<Instant>,
    pub working_since: Option<Instant>,
    pub done_at: Option<Instant>,
    title_aware: bool,
}

pub enum AgentEvent<'a> {
    Input,
    Output,
    Title { working: bool },
    Notification { message: &'a str, seen: bool },
    Seen,
    Reset,
}

impl AgentStatus {
    pub fn state(&self, now: Instant) -> AgentState {
        if self.waiting {
            AgentState::Waiting
        } else if self.working || self.output_working(now) {
            AgentState::Working
        } else if self.done {
            AgentState::Done
        } else {
            AgentState::Idle
        }
    }

    // 題名で作業中を知らせないもの（codex など）だけ、1秒以上続いている出力で考え中とみなす
    fn output_working(&self, now: Instant) -> bool {
        let Some(last) = self.last_output else { return false };
        if self.title_aware || now.duration_since(last) >= BUSY {
            return false;
        }
        last.duration_since(self.output_since.unwrap_or(last)) >= Duration::from_millis(1000)
    }

    pub fn apply(&mut self, event: AgentEvent<'_>, now: Instant) {
        let before = self.state(now);
        match event {
            AgentEvent::Input => {
                self.last_input = Some(now);
                self.waiting = false;
            }
            // 打った文字の折り返し表示は出力に数えない
            AgentEvent::Output => {
                if self.last_input.is_none_or(|t| now.duration_since(t) > Duration::from_millis(500)) {
                    if self.last_output.is_none_or(|t| now.duration_since(t) >= BUSY) {
                        self.output_since = Some(now);
                    }
                    self.last_output = Some(now);
                    self.waiting = false;
                }
            }
            AgentEvent::Title { working } => {
                if working {
                    self.waiting = false;
                    self.title_aware = true;
                } else if self.working {
                    self.last_output = None;
                }
                self.working = working;
            }
            AgentEvent::Notification { message, seen } => {
                if permission_message(message) {
                    self.waiting = true;
                    self.done = false;
                    self.working = false;
                    self.last_output = None;
                } else if !self.waiting {
                    self.working = false;
                    self.last_output = None;
                    self.done = !seen;
                    self.done_at = Some(now);
                }
            }
            AgentEvent::Seen => self.done = false,
            AgentEvent::Reset => {
                *self = AgentStatus::default();
                return;
            }
        }
        if self.state(now) == AgentState::Working {
            if before != AgentState::Working || self.working_since.is_none() {
                self.working_since = Some(now);
            }
            self.done = false;
        } else {
            self.working_since = None;
        }
    }

    pub fn text(&self, now: Instant) -> String {
        let state = self.state(now);
        let since = match state {
            AgentState::Working => self.working_since,
            AgentState::Done => self.done_at,
            _ => None,
        };
        let seconds = since.map(|t| now.duration_since(t).as_secs()).unwrap_or(0);
        match state {
            AgentState::Working if seconds >= 3600 => format!("考え中 {}時間{}分", seconds / 3600, seconds / 60 % 60),
            AgentState::Working => format!("考え中 {}:{:02}", seconds / 60, seconds % 60),
            AgentState::Waiting => "許可待ち".into(),
            AgentState::Done if seconds < 60 => "終わった · たった今".into(),
            AgentState::Done if seconds < 3600 => format!("終わった · {}分前", seconds / 60),
            AgentState::Done => format!("終わった · {}時間前", seconds / 3600),
            AgentState::Idle => String::new(),
        }
    }
}

// OSC 9 と OSC 777（notify）の通知を、出力の流れから拾う。区切りが読み込みの境目をまたいでも拾えるよう、状態を持つ
#[derive(Default)]
pub struct OscScanner {
    state: ScanState,
    buffer: Vec<u8>,
}

#[derive(Default, PartialEq)]
enum ScanState {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
}

const OSC_LIMIT: usize = 4096;

impl OscScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        for &b in bytes {
            self.state = match self.state {
                ScanState::Ground if b == 0x1b => ScanState::Escape,
                ScanState::Ground => ScanState::Ground,
                ScanState::Escape if b == b']' => {
                    self.buffer.clear();
                    ScanState::Osc
                }
                ScanState::Escape if b == 0x1b => ScanState::Escape,
                ScanState::Escape => ScanState::Ground,
                ScanState::Osc if b == 0x07 => {
                    found.extend(self.finish());
                    ScanState::Ground
                }
                ScanState::Osc if b == 0x1b => ScanState::OscEscape,
                ScanState::Osc => {
                    if self.buffer.len() < OSC_LIMIT {
                        self.buffer.push(b);
                    }
                    ScanState::Osc
                }
                ScanState::OscEscape if b == b'\\' => {
                    found.extend(self.finish());
                    ScanState::Ground
                }
                ScanState::OscEscape if b == b']' => {
                    self.buffer.clear();
                    ScanState::Osc
                }
                ScanState::OscEscape => ScanState::Ground,
            };
        }
        found
    }

    fn finish(&mut self) -> Option<String> {
        let text = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        notification_osc(&text)
    }
}

// 通知の本文。OSC 9;4 は進み具合の表示のため通知に数えない
pub fn notification_osc(body: &str) -> Option<String> {
    if let Some(rest) = body.strip_prefix("9;") {
        return (!rest.starts_with("4;")).then(|| clean(rest));
    }
    let rest = body.strip_prefix("777;notify;")?;
    Some(rest.split_once(';').map(|(_, message)| clean(message)).unwrap_or_default())
}

pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 題名の記号で作業中を見分ける() {
        assert_eq!(parse_title("✻ ログインを直す"), Title { working: true, text: Some("ログインを直す".into()) });
        assert_eq!(parse_title("✳ ログインを直す"), Title { working: false, text: Some("ログインを直す".into()) });
        assert_eq!(parse_title("⠂ Claude Code"), Title { working: true, text: None });
        assert_eq!(parse_title("vim"), Title { working: false, text: Some("vim".into()) });
    }

    #[test]
    fn シェルはエージェントに数えない() {
        assert!(!is_agent(Some("-zsh")));
        assert!(!is_agent(None));
        assert!(is_agent(Some("claude")));
    }

    #[test]
    fn 題名と通知で状態が移る() {
        let t0 = Instant::now();
        let mut s = AgentStatus::default();
        s.apply(AgentEvent::Title { working: true }, t0);
        assert_eq!(s.state(t0), AgentState::Working);
        s.apply(AgentEvent::Notification { message: "Claude needs your permission to use Bash", seen: false }, t0);
        assert_eq!(s.state(t0), AgentState::Waiting);
        s.apply(AgentEvent::Input, t0);
        s.apply(AgentEvent::Title { working: false }, t0);
        s.apply(AgentEvent::Notification { message: "Claude is waiting for your input", seen: false }, t0);
        assert_eq!(s.state(t0), AgentState::Done);
        s.apply(AgentEvent::Seen, t0);
        assert_eq!(s.state(t0), AgentState::Idle);
    }

    #[test]
    fn 見ている端末の終わりは印を残さない() {
        let t0 = Instant::now();
        let mut s = AgentStatus::default();
        s.apply(AgentEvent::Notification { message: "done", seen: true }, t0);
        assert_eq!(s.state(t0), AgentState::Idle);
    }

    #[test]
    fn 題名を出さないものは続く出力で考え中にする() {
        let t0 = Instant::now();
        let mut s = AgentStatus::default();
        s.apply(AgentEvent::Output, t0);
        assert_eq!(s.state(t0), AgentState::Idle);
        let t1 = t0 + Duration::from_millis(1200);
        s.apply(AgentEvent::Output, t1);
        assert_eq!(s.state(t1), AgentState::Working);
        assert_eq!(s.state(t1 + Duration::from_secs(3)), AgentState::Idle);
    }

    #[test]
    fn 経過の文言() {
        let t0 = Instant::now();
        let mut s = AgentStatus::default();
        s.apply(AgentEvent::Title { working: true }, t0);
        assert_eq!(s.text(t0 + Duration::from_secs(75)), "考え中 1:15");
    }

    #[test]
    fn 通知の区切りをまたいで拾う() {
        let mut scanner = OscScanner::default();
        assert!(scanner.feed(b"hello \x1b]9;Task ").is_empty());
        assert_eq!(scanner.feed(b"done\x07 rest"), vec!["Task done".to_string()]);
        assert_eq!(scanner.feed(b"\x1b]777;notify;Claude;Needs permission\x1b\\"), vec!["Needs permission".to_string()]);
        assert!(scanner.feed(b"\x1b]9;4;1;50\x07").is_empty());
        assert!(scanner.feed(b"\x1b]0;title\x07").is_empty());
    }
}
