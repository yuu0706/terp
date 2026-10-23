// シェルを持つ常駐のプロセス。terp を閉じてもシェルと中のプログラムを生かし、開き直したらつなぎ直させる。
// Electron の実行ファイルを ELECTRON_RUN_AS_NODE=1 で Node として起動する（main.js の startHost）。
// 使い方: <実行ファイル> ptyhost.js <ソケットのパス> <版>
// 通信は1行1つの JSON。種類（t）ごとの中身は ptyclient.js を参照
const net = require('net');
const fs = require('fs');
const pty = require('node-pty');

const [, , SOCKET, VERSION] = process.argv;
// つなぎ直したときに画面を作り直すため、出力の末尾をこの大きさまで残す
const REPLAY_LIMIT = 2 * 1024 * 1024;
// シェルもつなぐ相手も無い状態がこの時間続いたら終わる
const IDLE_EXIT_MS = 15000;

const sessions = new Map();
const clients = new Set();
let nextId = 1;
let idleSince = Date.now();

function send(client, msg) {
  if (!client.destroyed) client.write(JSON.stringify(msg) + '\n');
}

function broadcast(id, msg) {
  for (const c of clients) if (c.attached.has(id)) send(c, msg);
}

function create(client, { cols, rows, cwd, env, shell }) {
  const id = nextId++;
  const proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env });
  const s = { id, proc, cwd, pid: proc.pid, chunks: [], size: 0, meta: {}, createdAt: Date.now() };
  sessions.set(id, s);
  client.attached.add(id);
  proc.onData((data) => {
    s.chunks.push(data);
    s.size += data.length;
    while (s.size > REPLAY_LIMIT && s.chunks.length > 1) s.size -= s.chunks.shift().length;
    broadcast(id, { t: 'data', id, data });
  });
  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    for (const c of clients) {
      if (c.attached.has(id)) send(c, { t: 'exit', id, code: exitCode });
      c.attached.delete(id);
    }
  });
  return { id, cwd, pid: proc.pid };
}

function summary(s) {
  return { id: s.id, cwd: s.cwd, pid: s.pid, meta: s.meta, createdAt: s.createdAt };
}

function handle(client, msg) {
  const reply = (body) => send(client, { t: 'reply', reqId: msg.reqId, ...body });
  const s = sessions.get(msg.id);
  switch (msg.t) {
    case 'hello':
      return reply({ version: VERSION, pid: process.pid });
    case 'create':
      try {
        return reply({ value: create(client, msg) });
      } catch (err) {
        return reply({ error: err.message });
      }
    case 'list':
      return reply({ value: [...sessions.values()].map(summary) });
    case 'attach':
      if (!s) return reply({ error: `ターミナル ${msg.id} はありません` });
      client.attached.add(msg.id);
      // 残っている出力を先に流し、その後の出力を続けて流す
      return reply({ value: { replay: s.chunks.join('') } });
    case 'write':
      return s?.proc.write(msg.data);
    case 'resize':
      try {
        s?.proc.resize(msg.cols, msg.rows);
      } catch {
        // 終了直後の resize は無視する
      }
      return;
    case 'kill':
      return s?.proc.kill();
    case 'meta':
      if (s) s.meta = { ...s.meta, ...msg.meta };
      return;
    case 'info':
      return reply({
        value: [...sessions.values()].map((x) => {
          let program = '';
          try {
            program = x.proc.process;
          } catch {
            // 終了直後は名前が取れない
          }
          return { id: x.id, pid: x.pid, program };
        }),
      });
    case 'shutdown':
      // 自己診断で、Mac の再起動に当たる状態を作るためだけに使う
      for (const x of sessions.values()) x.proc.kill();
      reply({ value: true });
      return setTimeout(() => process.exit(0), 200);
  }
}

const server = net.createServer((client) => {
  client.attached = new Set();
  clients.add(client);
  client.setEncoding('utf8');
  let buf = '';
  client.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(client, JSON.parse(line));
      } catch {
        // 壊れた行は捨てる
      }
    }
  });
  client.on('close', () => {
    clients.delete(client);
    idleSince = Date.now();
  });
  client.on('error', () => {});
});

setInterval(() => {
  if (sessions.size > 0 || clients.size > 0) idleSince = Date.now();
  else if (Date.now() - idleSince > IDLE_EXIT_MS) process.exit(0);
}, 1000);

process.on('exit', () => {
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    // 既に無い
  }
});
process.on('SIGTERM', () => process.exit(0));

// main.js はつながらなかったときだけこのプロセスを起動するため、残っているソケットのファイルは古いものとして消す
try {
  fs.unlinkSync(SOCKET);
} catch {
  // 無ければそのまま
}
server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
