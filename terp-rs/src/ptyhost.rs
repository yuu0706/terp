// シェルを持つ常駐のプロセス（PTY ホスト）と、その通信の取り決め。
// terp を閉じてもシェルと中のプログラムを生かし、開き直したら出力の末尾を流し直してつなぎ直す。
// 起動: terp --pty-host <ソケットのパス>
use crate::terminal::{GridSize, ProcessInfo, foreground_of, spawn_pty};
use portable_pty::{Child, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROTOCOL: u32 = 1;

// 実行ファイルの版。アプリを入れ替えた後も古い常駐のプロセスが動き続けていないかを見分ける
pub fn build_id() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::metadata(exe).ok())
        .map(|m| {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            format!("{}-{t}", m.len())
        })
        .unwrap_or_default()
}

// 挨拶の返事: 取り決めの版（4バイト）と、JSON の { build, pid }
pub fn hello_payload() -> Vec<u8> {
    let mut out = PROTOCOL.to_le_bytes().to_vec();
    out.extend(serde_json::json!({ "build": build_id(), "pid": std::process::id() }).to_string().into_bytes());
    out
}
// つなぎ直したときに画面を作り直すため、出力の末尾をこの大きさまで残す
const REPLAY_LIMIT: usize = 2 * 1024 * 1024;
// シェルもつなぐ相手も無い状態がこの時間続いたら終わる
const IDLE_EXIT: Duration = Duration::from_secs(15);

pub fn socket_path() -> PathBuf {
    crate::config::config_dir().join("gpui-ptyhost.sock")
}

// ---- 通信の形 ----
// 1つの知らせ = 長さ（u32）・種類（u8）・端末の番号（u64）・中身

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    Create = 2,
    Attach = 3,
    Write = 4,
    Resize = 5,
    Kill = 6,
    List = 7,
    Info = 8,
    SetMeta = 9,
    HelloOk = 101,
    Created = 102,
    Output = 103,
    Exit = 104,
    Sessions = 105,
    InfoReply = 106,
    Replay = 107,
    ReplayEnd = 108,
}

impl Kind {
    fn from_u8(v: u8) -> Option<Kind> {
        use Kind::*;
        [Hello, Create, Attach, Write, Resize, Kill, List, Info, SetMeta, HelloOk, Created, Output, Exit, Sessions, InfoReply, Replay, ReplayEnd]
            .into_iter()
            .find(|k| *k as u8 == v)
    }
}

pub struct Frame {
    pub kind: Kind,
    pub id: u64,
    pub payload: Vec<u8>,
}

pub fn write_frame(stream: &mut impl Write, kind: Kind, id: u64, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(13 + payload.len());
    buf.extend_from_slice(&((9 + payload.len()) as u32).to_le_bytes());
    buf.push(kind as u8);
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(payload);
    stream.write_all(&buf)
}

pub fn read_frame(stream: &mut impl Read) -> std::io::Result<Frame> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if !(9..=64 * 1024 * 1024).contains(&len) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "知らせの長さが正しくない"));
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf)?;
    let kind = Kind::from_u8(buf[0]).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "知らない種類の知らせ"))?;
    let id = u64::from_le_bytes(buf[1..9].try_into().unwrap());
    Ok(Frame { kind, id, payload: buf[9..].to_vec() })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRequest {
    pub token: u64,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummary {
    pub id: u64,
    pub cwd: PathBuf,
    pub meta: serde_json::Value,
    pub size: GridSize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfoPayload {
    pub name: String,
    pub cwd: Option<PathBuf>,
    // 古い常駐のプロセスは送らない
    #[serde(default)]
    pub shell_pid: Option<i32>,
}

// ---- 流し直しの前に戻すモード ----
// 捨てた出力の中で切り替えたモード（全画面・マウス・貼り付けの括りなど）を覚え、流し直しの頭で戻す

const TRACKED_MODES: [u16; 10] = [1, 25, 47, 1047, 1049, 1000, 1002, 1003, 1006, 2004];

#[derive(Default)]
pub struct ModeTracker {
    modes: HashMap<u16, bool>,
    pending: Vec<u8>,
}

impl ModeTracker {
    // CSI ? n h / CSI ? n l を拾う。区切りが途中で切れた分は次に回す
    pub fn feed(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0x1b && data.get(i + 1) == Some(&b'[') && data.get(i + 2) == Some(&b'?') {
                let start = i + 3;
                let mut j = start;
                while j < data.len() && (data[j].is_ascii_digit() || data[j] == b';') {
                    j += 1;
                }
                if j >= data.len() {
                    // 続きは次の出力に来る。長すぎるものは捨てる
                    if data.len() - i < 64 {
                        self.pending = data[i..].to_vec();
                    }
                    return;
                }
                if data[j] == b'h' || data[j] == b'l' {
                    let on = data[j] == b'h';
                    for n in String::from_utf8_lossy(&data[start..j]).split(';').filter_map(|n| n.parse::<u16>().ok()) {
                        if TRACKED_MODES.contains(&n) {
                            self.modes.insert(n, on);
                        }
                    }
                }
                i = j + 1;
            } else {
                i += 1;
            }
        }
    }

    pub fn prefix(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut modes: Vec<_> = self.modes.iter().collect();
        modes.sort();
        for (n, on) in modes {
            out.extend_from_slice(format!("\x1b[?{n}{}", if *on { 'h' } else { 'l' }).as_bytes());
        }
        out
    }
}

// ---- ホスト ----

struct HostSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    buffer: VecDeque<u8>,
    dropped_modes: ModeTracker,
    cwd: PathBuf,
    meta: serde_json::Value,
    size: GridSize,
}

type Clients = HashMap<u64, Arc<Mutex<UnixStream>>>;

#[derive(Default)]
struct HostState {
    sessions: HashMap<u64, HostSession>,
    clients: Clients,
    attached: HashMap<u64, HashSet<u64>>,
    next_id: u64,
    idle_since: Option<Instant>,
}

impl HostState {
    fn broadcast(&mut self, session: u64, kind: Kind, payload: &[u8]) {
        let Some(clients) = self.attached.get(&session) else { return };
        for client in clients {
            if let Some(stream) = self.clients.get(client) {
                let _ = write_frame(&mut *stream.lock().unwrap(), kind, session, payload);
            }
        }
    }

    fn update_idle(&mut self) {
        self.idle_since = (self.sessions.is_empty() && self.clients.is_empty()).then(Instant::now);
    }
}

// exit_when_idle は本番の起動だけ true にする（テストでは実行ごと終わらせない）
pub fn run_host(socket: &Path, exit_when_idle: bool) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket)?;
    let state = Arc::new(Mutex::new(HostState { next_id: 1, idle_since: Some(Instant::now()), ..Default::default() }));

    // 誰もいなくなったら終わる
    let watch = state.clone();
    let socket_owned = socket.to_path_buf();
    std::thread::spawn(move || {
        if !exit_when_idle {
            return;
        }
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let idle = watch.lock().unwrap().idle_since.is_some_and(|t| t.elapsed() >= IDLE_EXIT);
            if idle {
                let _ = std::fs::remove_file(&socket_owned);
                std::process::exit(0);
            }
        }
    });

    let mut next_client = 1u64;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let client = next_client;
        next_client += 1;
        let writer = Arc::new(Mutex::new(stream.try_clone()?));
        {
            let mut s = state.lock().unwrap();
            s.clients.insert(client, writer.clone());
            s.update_idle();
        }
        let state = state.clone();
        std::thread::spawn(move || {
            let mut reader = stream;
            while let Ok(frame) = read_frame(&mut reader) {
                handle(&state, client, &writer, frame);
            }
            let mut s = state.lock().unwrap();
            s.clients.remove(&client);
            for set in s.attached.values_mut() {
                set.remove(&client);
            }
            s.update_idle();
        });
    }
    Ok(())
}

fn reply(writer: &Arc<Mutex<UnixStream>>, kind: Kind, id: u64, payload: &[u8]) {
    let _ = write_frame(&mut *writer.lock().unwrap(), kind, id, payload);
}

fn handle(state: &Arc<Mutex<HostState>>, client: u64, writer: &Arc<Mutex<UnixStream>>, frame: Frame) {
    match frame.kind {
        Kind::Hello => reply(writer, Kind::HelloOk, 0, &hello_payload()),
        Kind::List => {
            let s = state.lock().unwrap();
            let mut list: Vec<SessionSummary> =
                s.sessions.iter().map(|(id, h)| SessionSummary { id: *id, cwd: h.cwd.clone(), meta: h.meta.clone(), size: h.size }).collect();
            list.sort_by_key(|x| x.id);
            drop(s);
            reply(writer, Kind::Sessions, 0, &serde_json::to_vec(&list).unwrap_or_default());
        }
        Kind::Create => {
            let Ok(req) = serde_json::from_slice::<CreateRequest>(&frame.payload) else { return };
            let size = GridSize { cols: req.cols.max(2), rows: req.rows.max(1) };
            let (master, child, reader, writer_pty) = match spawn_pty(&req.cwd, size) {
                Ok(parts) => parts,
                Err(err) => {
                    eprintln!("シェルを起動できない: {err}");
                    reply(writer, Kind::Created, 0, &req.token.to_le_bytes());
                    return;
                }
            };
            let id = {
                let mut s = state.lock().unwrap();
                let id = s.next_id;
                s.next_id += 1;
                s.sessions.insert(
                    id,
                    HostSession {
                        master,
                        writer: writer_pty,
                        child,
                        buffer: VecDeque::new(),
                        dropped_modes: ModeTracker::default(),
                        cwd: req.cwd.clone(),
                        meta: req.meta.clone(),
                        size,
                    },
                );
                s.attached.entry(id).or_default().insert(client);
                s.update_idle();
                id
            };
            reply(writer, Kind::Created, id, &req.token.to_le_bytes());
            spawn_output_pump(state.clone(), id, reader);
        }
        Kind::Attach => {
            let mut s = state.lock().unwrap();
            let Some(session) = s.sessions.get(&frame.id) else {
                drop(s);
                reply(writer, Kind::Exit, frame.id, &[]);
                return;
            };
            let mut replay = session.dropped_modes.prefix();
            replay.extend(session.buffer.iter());
            s.attached.entry(frame.id).or_default().insert(client);
            // 流し直しの間に届く出力が前後しないよう、送り終えるまで状態を握る
            for chunk in replay.chunks(256 * 1024) {
                reply(writer, Kind::Replay, frame.id, chunk);
            }
            reply(writer, Kind::ReplayEnd, frame.id, &[]);
        }
        Kind::Write => {
            let mut s = state.lock().unwrap();
            if let Some(session) = s.sessions.get_mut(&frame.id) {
                let _ = session.writer.write_all(&frame.payload);
                let _ = session.writer.flush();
            }
        }
        Kind::Resize => {
            let Ok(size) = serde_json::from_slice::<GridSize>(&frame.payload) else { return };
            let mut s = state.lock().unwrap();
            if let Some(session) = s.sessions.get_mut(&frame.id) {
                session.size = size;
                let _ = session.master.resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
            }
        }
        Kind::Kill => {
            let mut s = state.lock().unwrap();
            if let Some(session) = s.sessions.get_mut(&frame.id) {
                let _ = session.child.kill();
            }
        }
        Kind::SetMeta => {
            let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else { return };
            if let Some(session) = state.lock().unwrap().sessions.get_mut(&frame.id) {
                session.meta = meta;
            }
        }
        Kind::Info => {
            let info = {
                let s = state.lock().unwrap();
                s.sessions.get(&frame.id).and_then(|h| foreground_of(h.master.as_ref(), h.child.process_id().map(|p| p as i32)))
            };
            if let Some(ProcessInfo { name, cwd, shell_pid }) = info {
                reply(writer, Kind::InfoReply, frame.id, &serde_json::to_vec(&InfoPayload { name, cwd, shell_pid }).unwrap_or_default());
            }
        }
        _ => {}
    }
}

fn spawn_output_pump(state: Arc<Mutex<HostState>>, id: u64, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut s = state.lock().unwrap();
            if let Some(session) = s.sessions.get_mut(&id) {
                session.buffer.extend(&buf[..n]);
                if session.buffer.len() > REPLAY_LIMIT {
                    let excess = session.buffer.len() - REPLAY_LIMIT;
                    let dropped: Vec<u8> = session.buffer.drain(..excess).collect();
                    session.dropped_modes.feed(&dropped);
                }
            }
            s.broadcast(id, Kind::Output, &buf[..n]);
        }
        let mut s = state.lock().unwrap();
        if let Some(mut session) = s.sessions.remove(&id) {
            let _ = session.child.wait();
        }
        s.broadcast(id, Kind::Exit, &[]);
        s.attached.remove(&id);
        s.update_idle();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 知らせを往復する() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Write, 7, b"ls\r").unwrap();
        let frame = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(frame.kind, Kind::Write);
        assert_eq!(frame.id, 7);
        assert_eq!(frame.payload, b"ls\r");
    }

    #[test]
    fn 捨てた出力のモードを流し直しの頭で戻す() {
        let mut t = ModeTracker::default();
        t.feed(b"abc\x1b[?1049h\x1b[?20");
        t.feed(b"04h text \x1b[?1049l\x1b[?1;1000h");
        let prefix = String::from_utf8(t.prefix()).unwrap();
        assert_eq!(prefix, "\x1b[?1h\x1b[?1000h\x1b[?1049l\x1b[?2004h");
    }
}
