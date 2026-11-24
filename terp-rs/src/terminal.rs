// 1つのターミナル。PTY のシェルと、画面の状態（alacritty_terminal）を持つ。
use alacritty_terminal::event::{Event as AlacEvent, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config as TermConfig, Term};
use alacritty_terminal::vte::ansi::Processor;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const SCROLLBACK: usize = 10_000;

#[derive(Debug)]
pub enum TermEvent {
    Wakeup,
    Title(String),
    ResetTitle,
    Bell,
    Clipboard(String),
    // OSC 9・777 の通知（claude などが応答の終わりや許可待ちを知らせる）
    Notify(String),
    Exit,
}

#[derive(Clone)]
pub struct Listener {
    events: UnboundedSender<TermEvent>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    size: Arc<Mutex<WindowSize>>,
}

impl EventListener for Listener {
    fn send_event(&self, event: AlacEvent) {
        let event = match event {
            AlacEvent::Title(title) => TermEvent::Title(title),
            AlacEvent::ResetTitle => TermEvent::ResetTitle,
            AlacEvent::Bell => TermEvent::Bell,
            AlacEvent::ClipboardStore(_, text) => TermEvent::Clipboard(text),
            // 端末への問い合わせ（端末の種類・大きさなど）の答えは、そのままシェルへ返す
            AlacEvent::PtyWrite(text) => {
                let _ = self.writer.lock().map(|mut w| w.write_all(text.as_bytes()));
                return;
            }
            AlacEvent::TextAreaSizeRequest(format) => {
                let size = *self.size.lock().unwrap();
                let _ = self.writer.lock().map(|mut w| w.write_all(format(size).as_bytes()));
                return;
            }
            _ => return,
        };
        let _ = self.events.unbounded_send(event);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridSize {
    pub cols: u16,
    pub rows: u16,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }
    fn screen_lines(&self) -> usize {
        self.rows as usize
    }
    fn columns(&self) -> usize {
        self.cols as usize
    }
}

pub struct Terminal {
    pub term: Arc<FairMutex<Term<Listener>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    size: GridSize,
    window_size: Arc<Mutex<WindowSize>>,
    wakeup_pending: Arc<AtomicBool>,
}

// 起動元（cargo・Claude Code など）の環境変数をシェルへ持ち込まない
fn shell_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| {
            !(key.starts_with("CARGO") || key.starts_with("RUST") || key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_"))
        })
        .collect();
    let lang = env.iter().find(|(k, _)| k == "LANG").map(|(_, v)| v.clone());
    env.retain(|(k, _)| !matches!(k.as_str(), "TERM" | "COLORTERM" | "TERM_PROGRAM" | "TERM_PROGRAM_VERSION" | "LANG"));
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    env.push(("TERM_PROGRAM".into(), "terp".into()));
    env.push(("TERM_PROGRAM_VERSION".into(), env!("CARGO_PKG_VERSION").into()));
    let utf8 = lang.filter(|l| l.to_ascii_lowercase().replace('-', "").contains("utf8"));
    env.push(("LANG".into(), utf8.unwrap_or_else(|| "ja_JP.UTF-8".into())));
    env
}

impl Terminal {
    pub fn spawn(cwd: &Path, size: GridSize) -> anyhow::Result<(Terminal, UnboundedReceiver<TermEvent>)> {
        let pty = native_pty_system().openpty(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 })?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env_clear();
        for (key, value) in shell_env() {
            cmd.env(key, value);
        }
        let child = pty.slave.spawn_command(cmd)?;
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader()?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pty.master.take_writer()?));
        let (events_tx, events_rx) = unbounded();
        let window_size = Arc::new(Mutex::new(WindowSize { num_lines: size.rows, num_cols: size.cols, cell_width: 8, cell_height: 16 }));
        let listener = Listener { events: events_tx.clone(), writer: writer.clone(), size: window_size.clone() };
        let config = TermConfig { scrolling_history: SCROLLBACK, ..TermConfig::default() };
        let term = Arc::new(FairMutex::new(Term::new(config, &size, listener)));
        let wakeup_pending = Arc::new(AtomicBool::new(false));

        let thread_term = term.clone();
        let thread_wakeup = wakeup_pending.clone();
        std::thread::Builder::new().name("terp-pty-reader".into()).spawn(move || {
            let mut parser: Processor = Processor::new();
            let mut scanner = crate::agent::OscScanner::default();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for message in scanner.feed(&buf[..n]) {
                            let _ = events_tx.unbounded_send(TermEvent::Notify(message));
                        }
                        let mut term = thread_term.lock();
                        parser.advance(&mut *term, &buf[..n]);
                        drop(term);
                        // 画面の更新の知らせは、描き終わるまで1つにまとめる
                        if !thread_wakeup.swap(true, Ordering::AcqRel) {
                            let _ = events_tx.unbounded_send(TermEvent::Wakeup);
                        }
                    }
                }
            }
            let _ = events_tx.unbounded_send(TermEvent::Exit);
        })?;

        Ok((Terminal { term, writer, master: pty.master, child, size, window_size, wakeup_pending }, events_rx))
    }

    pub fn clear_wakeup(&self) {
        self.wakeup_pending.store(false, Ordering::Release);
    }

    pub fn write(&self, bytes: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(bytes);
            let _ = writer.flush();
        }
    }

    pub fn resize(&mut self, size: GridSize, cell_width: u16, cell_height: u16) {
        if size == self.size || size.cols == 0 || size.rows == 0 {
            return;
        }
        self.size = size;
        *self.window_size.lock().unwrap() = WindowSize { num_lines: size.rows, num_cols: size.cols, cell_width, cell_height };
        let _ = self.master.resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
        self.term.lock().resize(size);
    }

    pub fn shell_pid(&self) -> Option<i32> {
        self.child.process_id().map(|pid| pid as i32)
    }

    // 端末の前面で動いているプロセス（シェルか、シェルから起動したプログラム）
    pub fn foreground(&self) -> Option<ProcessInfo> {
        let pid = self.master.process_group_leader().or_else(|| self.shell_pid())?;
        Some(ProcessInfo { name: process_name(pid)?, cwd: process_cwd(pid) })
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.kill();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub name: String,
    pub cwd: Option<PathBuf>,
}

fn process_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let name = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    // ログインシェルは "-zsh" と名乗る
    Some(name.trim_start_matches('-').to_string())
}

fn process_cwd(pid: i32) -> Option<PathBuf> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
    if n != size {
        return None;
    }
    let raw = &info.pvi_cdir.vip_path;
    let bytes: Vec<u8> = raw.iter().flat_map(|chunk| chunk.iter()).map(|&c| c as u8).take_while(|&c| c != 0).collect();
    (!bytes.is_empty()).then(|| PathBuf::from(String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 自分のプロセスの名前と作業場所を読める() {
        let pid = std::process::id() as i32;
        assert!(process_name(pid).is_some());
        assert_eq!(process_cwd(pid), std::env::current_dir().ok());
    }

    #[test]
    fn シェルの出力が画面に届く() {
        let dir = std::env::temp_dir();
        let (terminal, _events) = Terminal::spawn(&dir, GridSize { cols: 80, rows: 24 }).unwrap();
        terminal.write(b"echo terp-$((40+2))\r");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let text = {
                let term = terminal.term.lock();
                let grid = term.grid();
                (0..grid.screen_lines())
                    .map(|line| {
                        let row = &grid[alacritty_terminal::index::Line(line as i32)];
                        (0..grid.columns()).map(|col| row[alacritty_terminal::index::Column(col)].c).collect::<String>()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            if text.contains("terp-42") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "出力が届かない:\n{text}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}
