// 常駐のプロセス（ptyhost.js）とつなぐ口。無ければ起動してからつなぐ
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { CONFIG_DIR } = require('./config');

const HOST_SCRIPT = path.join(__dirname, 'ptyhost.js');
// ソケットのパスは 104 バイトまでのため、設定のフォルダの名前から短い名前を作って一時フォルダに置く。
// 設定のフォルダごとに分かれるため、自己診断（TERP_CONFIG_DIR）は利用者の常駐のプロセスとつながらない
const SOCKET = path.join(os.tmpdir(), `terp-${crypto.createHash('sha1').update(CONFIG_DIR).digest('hex').slice(0, 10)}.sock`);

// 常駐のプロセスのコードが変わったかを見分ける版。変わっていても、シェルを守るため古いものを使い続ける
// 常駐のプロセスが読むファイル。どれかが変わったら版も変わる
const HOST_FILES = [HOST_SCRIPT, path.join(__dirname, 'hostmodes.js')];
function hostVersion() {
  const hash = crypto.createHash('sha1');
  for (const file of HOST_FILES) hash.update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PtyClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.pending = new Map();
    this.nextReq = 1;
    this.hostVersion = null;
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  startHost() {
    const child = spawn(process.execPath, [HOST_SCRIPT, SOCKET, hostVersion()], {
      detached: true,
      stdio: 'ignore',
      cwd: os.homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }

  async connect() {
    let socket = await this.connectOnce().catch(() => null);
    if (!socket) {
      this.startHost();
      for (let i = 0; i < 50 && !socket; i++) {
        await sleep(100);
        socket = await this.connectOnce().catch(() => null);
      }
      if (!socket) throw new Error('シェルを持つ常駐のプロセスを起動できませんでした');
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.onMessage(JSON.parse(line));
      }
    });
    socket.on('close', () => this.emit('disconnect'));
    socket.on('error', () => {});
    const hello = await this.request({ t: 'hello' });
    this.hostVersion = hello.version;
    return { fresh: hello.version === hostVersion(), version: hello.version };
  }

  onMessage(msg) {
    if (msg.t === 'reply') {
      const p = this.pending.get(msg.reqId);
      this.pending.delete(msg.reqId);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.value !== undefined ? msg.value : msg);
    } else if (msg.t === 'data') this.emit('data', msg.id, msg.data);
    else if (msg.t === 'exit') this.emit('exit', msg.id, msg.code);
  }

  request(msg) {
    const reqId = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.send({ ...msg, reqId });
    });
  }

  send(msg) {
    if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(msg) + '\n');
  }
}

module.exports = { PtyClient, SOCKET };
