// 1つのターミナル。画面の状態（alacritty_terminal）を持ち、シェルは PTY ホストか、この窓のプロセスで動かす。
use crate::ptyhost::{self, CreateRequest, Frame, InfoPayload, Kind, SessionSummary, read_frame, write_frame};
use alacritty_terminal::event::{Event as AlacEvent, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config as TermConfig, Term};
use alacritty_terminal::vte::ansi::Processor;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    // つなぎ直したときの出力の流し直し。この間の題名やベルは知らせに数えない
    ReplayStart,
    ReplayEnd,
    Exit,
}

// シェルへ書く先。PTY ホストか、手元の PTY
type Sink = Arc<dyn Fn(&[u8]) + Send + Sync>;

#[derive(Clone)]
pub struct Listener {
    events: UnboundedSender<TermEvent>,
    sink: Sink,
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
                (self.sink)(text.as_bytes());
                return;
            }
            AlacEvent::TextAreaSizeRequest(format) => {
                let size = *self.size.lock().unwrap();
                (self.sink)(format(size).as_bytes());
                return;
            }
            _ => return,
        };
        let _ = self.events.unbounded_send(event);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub name: String,
    pub cwd: Option<PathBuf>,
    // シェルの pid。エージェントの会話の記録を探すのに使う
    pub shell_pid: Option<i32>,
}

// 画面の状態を作る側へ渡すもの
pub enum Incoming {
    Output(Vec<u8>),
    Replay(Vec<u8>),
    ReplayEnd,
    Info(ProcessInfo),
    Exit,
}

// 起動元（cargo・Claude Code など）の環境変数をシェルへ持ち込まない
fn shell_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| {
            !(key.starts_with("CARGO")
                || key.starts_with("RUST")
                || key.starts_with("ELECTRON_")
                || key.starts_with("npm_")
                || key == "NODE_OPTIONS"
                || key == "CLAUDECODE"
                || key.starts_with("CLAUDE_CODE_"))
        })
        .collect();
    // npm から起動したときに npm が足す EDITOR=vi を渡すと、zsh が vi の打ち方で始まる
    env.retain(|(k, v)| !(k == "EDITOR" && v == "vi"));
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

pub type PtyParts = (Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>, Box<dyn Read + Send>, Box<dyn Write + Send>);

pub fn spawn_pty(cwd: &Path, size: GridSize) -> anyhow::Result<PtyParts> {
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
    let reader = pty.master.try_clone_reader()?;
    let writer = pty.master.take_writer()?;
    Ok((pty.master, child, reader, writer))
}

// 端末の前面で動いているプロセス（シェルか、シェルから起動したプログラム）
pub fn foreground_of(master: &dyn MasterPty, shell_pid: Option<i32>) -> Option<ProcessInfo> {
    let pid = master.process_group_leader().or(shell_pid)?;
    Some(ProcessInfo { name: program_name(process_name(pid)?), cwd: process_cwd(pid), shell_pid })
}

// claude の実行ファイルは版番号（例 2.1.309）の名前で動くため、claude と読み替える
pub fn program_name(name: String) -> String {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        return "claude".into();
    }
    name
}

enum Backend {
    Local { master: Box<dyn MasterPty + Send>, child: Box<dyn Child + Send + Sync> },
    Remote { client: Arc<HostClient>, id: u64 },
}

pub struct Terminal {
    pub term: Arc<FairMutex<Term<Listener>>>,
    sink: Sink,
    backend: Backend,
    size: GridSize,
    window_size: Arc<Mutex<WindowSize>>,
    wakeup_pending: Arc<AtomicBool>,
    info: Arc<Mutex<Option<ProcessInfo>>>,
}

struct Parts {
    term: Arc<FairMutex<Term<Listener>>>,
    window_size: Arc<Mutex<WindowSize>>,
    wakeup_pending: Arc<AtomicBool>,
    info: Arc<Mutex<Option<ProcessInfo>>>,
    incoming: Sender<Incoming>,
    events: UnboundedReceiver<TermEvent>,
}

// 届いた出力を画面の状態へ写す。描き終わるまで更新の知らせは1つにまとめる
fn start_processing(size: GridSize, sink: Sink) -> Parts {
    let (events_tx, events_rx) = unbounded();
    let window_size = Arc::new(Mutex::new(WindowSize { num_lines: size.rows, num_cols: size.cols, cell_width: 8, cell_height: 16 }));
    let listener = Listener { events: events_tx.clone(), sink, size: window_size.clone() };
    let config = TermConfig { scrolling_history: SCROLLBACK, ..TermConfig::default() };
    let term = Arc::new(FairMutex::new(Term::new(config, &size, listener)));
    let wakeup_pending = Arc::new(AtomicBool::new(false));
    let info = Arc::new(Mutex::new(None));
    let (incoming_tx, incoming_rx): (Sender<Incoming>, Receiver<Incoming>) = channel();

    let (thread_term, thread_wakeup, thread_info) = (term.clone(), wakeup_pending.clone(), info.clone());
    std::thread::Builder::new()
        .name("terp-term".into())
        .spawn(move || {
            let mut parser: Processor = Processor::new();
            let mut scanner = crate::agent::OscScanner::default();
            let mut replaying = false;
            let wake = |events: &UnboundedSender<TermEvent>| {
                if !thread_wakeup.swap(true, Ordering::AcqRel) {
                    let _ = events.unbounded_send(TermEvent::Wakeup);
                }
            };
            while let Ok(message) = incoming_rx.recv() {
                match message {
                    Incoming::Replay(bytes) => {
                        if !replaying {
                            replaying = true;
                            let _ = events_tx.unbounded_send(TermEvent::ReplayStart);
                        }
                        // 流し直しの中の通知は、前に知らせ済みのものなので拾わない
                        let _ = scanner.feed(&bytes);
                        parser.advance(&mut *thread_term.lock(), &bytes);
                        wake(&events_tx);
                    }
                    Incoming::Output(bytes) => {
                        for message in scanner.feed(&bytes) {
                            let _ = events_tx.unbounded_send(TermEvent::Notify(message));
                        }
                        parser.advance(&mut *thread_term.lock(), &bytes);
                        wake(&events_tx);
                    }
                    Incoming::ReplayEnd => {
                        replaying = false;
                        let _ = events_tx.unbounded_send(TermEvent::ReplayEnd);
                    }
                    Incoming::Info(process) => *thread_info.lock().unwrap() = Some(process),
                    Incoming::Exit => {
                        let _ = events_tx.unbounded_send(TermEvent::Exit);
                        break;
                    }
                }
            }
        })
        .expect("端末の処理を始められない");
    Parts { term, window_size, wakeup_pending, info, incoming: incoming_tx, events: events_rx }
}

impl Terminal {
    // この窓のプロセスでシェルを動かす。PTY ホストを使えないときの予備
    pub fn spawn_local(cwd: &Path, size: GridSize) -> anyhow::Result<(Terminal, UnboundedReceiver<TermEvent>)> {
        let (master, child, mut reader, writer) = spawn_pty(cwd, size)?;
        let writer = Mutex::new(writer);
        let sink: Sink = Arc::new(move |bytes: &[u8]| {
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_all(bytes);
                let _ = w.flush();
            }
        });
        let parts = start_processing(size, sink.clone());
        let incoming = parts.incoming.clone();
        std::thread::Builder::new().name("terp-pty-reader".into()).spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if incoming.send(Incoming::Output(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = incoming.send(Incoming::Exit);
        })?;
        Ok((Terminal::from_parts(parts.term, sink, Backend::Local { master, child }, size, parts.window_size, parts.wakeup_pending, parts.info), parts.events))
    }

    // PTY ホストに新しいシェルを作る
    pub fn create_remote(client: &Arc<HostClient>, cwd: &Path, size: GridSize, meta: serde_json::Value) -> anyhow::Result<(Terminal, UnboundedReceiver<TermEvent>)> {
        let id = client.create(cwd, size, meta)?;
        Ok(Self::connect_remote(client, id, size, false))
    }

    // PTY ホストに残っているシェルへつなぎ直し、出力の末尾を流し直す
    pub fn attach_remote(client: &Arc<HostClient>, id: u64, size: GridSize) -> (Terminal, UnboundedReceiver<TermEvent>) {
        Self::connect_remote(client, id, size, true)
    }

    fn connect_remote(client: &Arc<HostClient>, id: u64, size: GridSize, attach: bool) -> (Terminal, UnboundedReceiver<TermEvent>) {
        let sink_client = client.clone();
        let sink: Sink = Arc::new(move |bytes: &[u8]| sink_client.send(Kind::Write, id, bytes));
        let parts = start_processing(size, sink.clone());
        client.register(id, parts.incoming.clone());
        if attach {
            parts.incoming.send(Incoming::Replay(Vec::new())).ok();
            client.send(Kind::Attach, id, &[]);
        }
        let terminal = Terminal::from_parts(
            parts.term,
            sink,
            Backend::Remote { client: client.clone(), id },
            size,
            parts.window_size,
            parts.wakeup_pending,
            parts.info,
        );
        (terminal, parts.events)
    }

    fn from_parts(
        term: Arc<FairMutex<Term<Listener>>>,
        sink: Sink,
        backend: Backend,
        size: GridSize,
        window_size: Arc<Mutex<WindowSize>>,
        wakeup_pending: Arc<AtomicBool>,
        info: Arc<Mutex<Option<ProcessInfo>>>,
    ) -> Terminal {
        Terminal { term, sink, backend, size, window_size, wakeup_pending, info }
    }

    // 常駐のプロセスでのシェルの番号。開き直しても変わらない
    pub fn remote_id(&self) -> Option<u64> {
        match &self.backend {
            Backend::Remote { id, .. } => Some(*id),
            Backend::Local { .. } => None,
        }
    }

    // 常駐のプロセスに、開き直したときに戻す情報（ワークスペース・名前）を預ける
    pub fn set_meta(&self, meta: &serde_json::Value) {
        if let Backend::Remote { client, id } = &self.backend {
            client.send(crate::ptyhost::Kind::SetMeta, *id, meta.to_string().as_bytes());
        }
    }

    pub fn clear_wakeup(&self) {
        self.wakeup_pending.store(false, Ordering::Release);
    }

    pub fn write(&self, bytes: &[u8]) {
        (self.sink)(bytes);
    }

    pub fn resize(&mut self, size: GridSize, cell_width: u16, cell_height: u16) {
        if size == self.size || size.cols == 0 || size.rows == 0 {
            return;
        }
        self.size = size;
        *self.window_size.lock().unwrap() = WindowSize { num_lines: size.rows, num_cols: size.cols, cell_width, cell_height };
        match &self.backend {
            Backend::Local { master, .. } => {
                let _ = master.resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
            }
            Backend::Remote { client, id } => client.send(Kind::Resize, *id, &serde_json::to_vec(&size).unwrap_or_default()),
        }
        self.term.lock().resize(size);
    }

    // 今の大きさを送り直す。同じ端末を別の窓が違う大きさにしていても、こちらの大きさに戻す
    pub fn resend_size(&self) {
        let size = self.size;
        match &self.backend {
            Backend::Local { master, .. } => {
                let _ = master.resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
            }
            Backend::Remote { client, id } => client.send(Kind::Resize, *id, &serde_json::to_vec(&size).unwrap_or_default()),
        }
    }

    // 大きさを一度変えて戻し、全画面のプログラムに描き直させる（SIGWINCH）
    pub fn redraw(&self) {
        let size = self.size;
        let nudged = GridSize { cols: size.cols.saturating_sub(1).max(2), rows: size.rows };
        match &self.backend {
            Backend::Local { master, .. } => {
                let _ = master.resize(PtySize { rows: nudged.rows, cols: nudged.cols, pixel_width: 0, pixel_height: 0 });
                let _ = master.resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
            }
            Backend::Remote { client, id } => {
                client.send(Kind::Resize, *id, &serde_json::to_vec(&nudged).unwrap_or_default());
                client.send(Kind::Resize, *id, &serde_json::to_vec(&size).unwrap_or_default());
            }
        }
    }

    // PTY ホストの場合は、前の問い合わせの答えを返し、次の問い合わせを出す
    pub fn foreground(&self) -> Option<ProcessInfo> {
        match &self.backend {
            Backend::Local { master, child } => foreground_of(master.as_ref(), child.process_id().map(|p| p as i32)),
            Backend::Remote { client, id } => {
                client.send(Kind::Info, *id, &[]);
                self.info.lock().unwrap().clone()
            }
        }
    }

    // タブを閉じたときだけシェルを終わらせる。窓を閉じても PTY ホストのシェルは残す
    pub fn kill(&mut self) {
        match &mut self.backend {
            Backend::Local { child, .. } => {
                let _ = child.kill();
            }
            Backend::Remote { client, id } => client.send(Kind::Kill, *id, &[]),
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        match &mut self.backend {
            Backend::Local { child, .. } => {
                let _ = child.kill();
            }
            Backend::Remote { client, id } => client.unregister(*id),
        }
    }
}

// ---- PTY ホストへのつなぎ ----

pub struct HostClient {
    // 常駐のプロセスの実行ファイルの版（古い版は空）と pid
    pub build: String,
    pub pid: Option<i32>,
    pub socket: PathBuf,
    writer: Mutex<UnixStream>,
    routes: Mutex<HashMap<u64, Sender<Incoming>>>,
    pending: Mutex<HashMap<u64, Sender<u64>>>,
    next_token: AtomicU64,
}

impl HostClient {
    // 自分と違う版の実行ファイルで動いている
    pub fn outdated(&self) -> bool {
        self.build != ptyhost::build_id()
    }

    // 常駐のプロセスを終わらせる（中のシェルもすべて終わる）。古い版は pid を返さないため、ソケットを開いているものから探す
    pub fn terminate(&self) {
        let pid = self.pid.or_else(|| {
            let mut cmd = std::process::Command::new("/usr/sbin/lsof");
            cmd.args(["-t", &self.socket.display().to_string()]);
            let out = crate::git::run_with_timeout(&mut cmd, None, Duration::from_secs(5)).ok()?;
            let me = std::process::id() as i32;
            String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<i32>().ok()).find(|p| *p != me)
        });
        if let Some(pid) = pid {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }

    // ホストへつなぐ。いなければ起動して待つ。残っているシェルの一覧も返す
    pub fn connect() -> anyhow::Result<(Arc<HostClient>, Vec<SessionSummary>)> {
        Self::connect_to(&ptyhost::socket_path(), true)
    }

    pub fn connect_to(socket: &Path, spawn: bool) -> anyhow::Result<(Arc<HostClient>, Vec<SessionSummary>)> {
        let socket = socket.to_path_buf();
        let stream = match UnixStream::connect(&socket) {
            Ok(stream) => stream,
            Err(err) if !spawn => return Err(err.into()),
            Err(_) => {
                spawn_host(&socket)?;
                let mut connected = None;
                for _ in 0..50 {
                    std::thread::sleep(Duration::from_millis(100));
                    if let Ok(stream) = UnixStream::connect(&socket) {
                        connected = Some(stream);
                        break;
                    }
                }
                connected.ok_or_else(|| anyhow::anyhow!("常駐のプロセスにつなげない: {}", socket.display()))?
            }
        };
        let mut reader = stream.try_clone()?;
        let mut writer = stream;
        reader.set_read_timeout(Some(Duration::from_secs(5)))?;
        write_frame(&mut writer, Kind::Hello, 0, &ptyhost::PROTOCOL.to_le_bytes())?;
        let hello = read_frame(&mut reader)?;
        let version = hello.payload.get(..4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
        if hello.kind != Kind::HelloOk || version != ptyhost::PROTOCOL {
            anyhow::bail!("常駐のプロセスの版が違う（{version}）");
        }
        // 古い常駐のプロセスは版と pid を返さない
        let info: serde_json::Value = hello.payload.get(4..).and_then(|b| serde_json::from_slice(b).ok()).unwrap_or(serde_json::Value::Null);
        let host_build = info.get("build").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let host_pid = info.get("pid").and_then(|v| v.as_u64()).map(|p| p as i32);
        write_frame(&mut writer, Kind::List, 0, &[])?;
        let list = read_frame(&mut reader)?;
        let sessions: Vec<SessionSummary> = serde_json::from_slice(&list.payload).unwrap_or_default();
        reader.set_read_timeout(None)?;

        let client = Arc::new(HostClient {
            build: host_build,
            pid: host_pid,
            socket: socket.to_path_buf(),
            writer: Mutex::new(writer),
            routes: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_token: AtomicU64::new(1),
        });
        let dispatcher = client.clone();
        std::thread::Builder::new().name("terp-host-client".into()).spawn(move || {
            while let Ok(frame) = read_frame(&mut reader) {
                dispatcher.dispatch(frame);
            }
            // ホストとのつながりが切れたら、どの端末も続けられない
            for (_, route) in dispatcher.routes.lock().unwrap().drain() {
                let _ = route.send(Incoming::Exit);
            }
        })?;
        Ok((client, sessions))
    }

    fn dispatch(&self, frame: Frame) {
        let route = |incoming: Incoming| {
            if let Some(tx) = self.routes.lock().unwrap().get(&frame.id) {
                let _ = tx.send(incoming);
            }
        };
        match frame.kind {
            Kind::Output => route(Incoming::Output(frame.payload)),
            Kind::Replay => route(Incoming::Replay(frame.payload)),
            Kind::ReplayEnd => route(Incoming::ReplayEnd),
            Kind::InfoReply => {
                if let Ok(info) = serde_json::from_slice::<InfoPayload>(&frame.payload) {
                    route(Incoming::Info(ProcessInfo { name: program_name(info.name), cwd: info.cwd, shell_pid: info.shell_pid }));
                }
            }
            Kind::Exit => {
                if let Some(tx) = self.routes.lock().unwrap().remove(&frame.id) {
                    let _ = tx.send(Incoming::Exit);
                }
            }
            Kind::Created => {
                let token = frame.payload.get(..8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
                if let Some(tx) = self.pending.lock().unwrap().remove(&token) {
                    let _ = tx.send(frame.id);
                }
            }
            _ => {}
        }
    }

    pub fn send(&self, kind: Kind, id: u64, payload: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = write_frame(&mut *writer, kind, id, payload);
        }
    }

    fn create(&self, cwd: &Path, size: GridSize, meta: serde_json::Value) -> anyhow::Result<u64> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(token, tx);
        let request = CreateRequest { token, cwd: cwd.to_path_buf(), cols: size.cols, rows: size.rows, meta };
        self.send(Kind::Create, 0, &serde_json::to_vec(&request)?);
        let id = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| anyhow::anyhow!("常駐のプロセスから返事が無い"))?;
        if id == 0 {
            anyhow::bail!("常駐のプロセスがシェルを起動できない");
        }
        Ok(id)
    }

    fn register(&self, id: u64, tx: Sender<Incoming>) {
        self.routes.lock().unwrap().insert(id, tx);
    }

    fn unregister(&self, id: u64) {
        self.routes.lock().unwrap().remove(&id);
    }
}

// ホストは terp と同じ実行ファイルを別のセッションで起動し、terp を閉じても残す
fn spawn_host(socket: &Path) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()?;
    let log = crate::config::config_dir().join("gpui-ptyhost.log");
    std::fs::create_dir_all(crate::config::config_dir())?;
    let stderr = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("--pty-host")
        .arg(socket)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(stderr);
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn()?;
    Ok(())
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

    fn screen_text(terminal: &Terminal) -> String {
        let term = terminal.term.lock();
        let grid = term.grid();
        (0..grid.screen_lines())
            .map(|line| {
                let row = &grid[alacritty_terminal::index::Line(line as i32)];
                (0..grid.columns()).map(|col| row[alacritty_terminal::index::Column(col)].c).collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for(terminal: &Terminal, needle: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let text = screen_text(terminal);
            if text.contains(needle) {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "出力が届かない:\n{text}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn 版番号の名前は_claude_と読む() {
        assert_eq!(program_name("2.1.309".into()), "claude");
        assert_eq!(program_name("zsh".into()), "zsh");
        assert_eq!(program_name("node.js".into()), "node.js");
    }

    #[test]
    fn 自分のプロセスの名前と作業場所を読める() {
        let pid = std::process::id() as i32;
        assert!(process_name(pid).is_some());
        assert_eq!(process_cwd(pid), std::env::current_dir().ok());
    }

    #[test]
    fn 窓を閉じてもシェルが残り_つなぎ直すと出力が戻る() {
        let dir = std::env::temp_dir().join(format!("terp-host-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("host.sock");
        let host_socket = socket.clone();
        std::thread::spawn(move || ptyhost::run_host(&host_socket, false));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            assert!(std::time::Instant::now() < deadline, "ホストが始まらない");
            std::thread::sleep(Duration::from_millis(20));
        }

        let size = GridSize { cols: 80, rows: 24 };
        let (client, sessions) = HostClient::connect_to(&socket, false).unwrap();
        assert!(sessions.is_empty());
        let (terminal, _events) = Terminal::create_remote(&client, &dir, size, serde_json::json!({ "workspace": "w1" })).unwrap();
        terminal.write(b"echo kept-$((6*7))\r");
        wait_for(&terminal, "kept-42");
        // 窓を閉じた相当。シェルは終わらせない
        drop(terminal);
        drop(client);

        let (client, sessions) = HostClient::connect_to(&socket, false).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].meta["workspace"], "w1");
        let (mut terminal, _events) = Terminal::attach_remote(&client, sessions[0].id, sessions[0].size);
        wait_for(&terminal, "kept-42");
        terminal.write(b"echo again\r");
        wait_for(&terminal, "again");
        terminal.kill();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn シェルの出力が画面に届く() {
        let (terminal, _events) = Terminal::spawn_local(&std::env::temp_dir(), GridSize { cols: 80, rows: 24 }).unwrap();
        terminal.write(b"echo terp-$((40+2))\r");
        wait_for(&terminal, "terp-42");
    }
}
