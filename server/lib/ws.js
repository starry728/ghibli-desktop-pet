/**
 * 极简 WebSocket 客户端（零依赖，基于 node:net / node:tls）
 *
 * 为什么不用 Node 内置的全局 WebSocket？
 *   Edge TTS 服务强制校验 `Origin` / `Pragma` / `User-Agent` 等请求头，
 *   而浏览器规范的 WebSocket 构造函数不允许自定义请求头，只能自己实现握手。
 *
 * 支持：文本/二进制帧、分片重组、ping/pong、close 握手、掩码编码。
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes, createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 构造客户端帧（必须掩码） */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];

  return Buffer.concat([header, masked]);
}

/**
 * 建立 WebSocket 连接。
 * @param {string} url  ws:// 或 wss://
 * @param {object} opts
 * @param {Record<string,string>} [opts.headers] 额外请求头
 * @param {number} [opts.timeoutMs] 握手超时
 * @returns {Promise<WebSocketLite>}
 */
export function connect(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`WebSocket 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const requestLines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    for (const [k, v] of Object.entries(headers)) requestLines.push(`${k}: ${v}`);
    const request = requestLines.join('\r\n') + '\r\n\r\n';

    const onConnect = () => socket.write(request);
    if (secure) socket.once('secureConnect', onConnect);
    else socket.once('connect', onConnect);

    let buffer = Buffer.alloc(0);
    let handshakeDone = false;

    const ws = new WebSocketLite(socket);
    ws._opened = false;
    ws._queue = [];

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);

        const statusLine = head.split('\r\n')[0];
        if (!/ 101 /.test(statusLine)) {
          return fail(new Error(`WebSocket 握手被拒绝：${statusLine}`));
        }
        const acceptMatch = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (!acceptMatch || acceptMatch[1] !== expectedAccept) {
          return fail(new Error('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
        }

        handshakeDone = true;
        settled = true;
        clearTimeout(timer);
        ws._opened = true;
        socket.removeListener('data', onData);
        socket.on('data', (c) => ws._onData(c));
        if (buffer.length) ws._onData(buffer);
        resolve(ws);
        queueMicrotask(() => ws._emit('open'));
        return;
      }
    };

    socket.on('data', onData);
    socket.once('error', (e) => fail(e));
    socket.once('close', () => {
      if (!settled) fail(new Error('WebSocket 连接在握手完成前被关闭'));
      else ws._emit('close');
    });
  });
}

class WebSocketLite {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(...args); } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  send(data) {
    if (this.closed) return;
    const opcode = Buffer.isBuffer(data) ? OP.BINARY : OP.TEXT;
    this.socket.write(encodeFrame(opcode, data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0)));
    } catch { /* ignore */ }
    this.socket.end();
  }

  /** 解析服务端帧（服务端发来的帧不带掩码） */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this.close(); return; }
        len = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);

      if (maskKey) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }

      if (opcode === OP.PING) { this.socket.write(encodeFrame(OP.PONG, payload)); continue; }
      if (opcode === OP.PONG) continue;
      if (opcode === OP.CLOSE) {
        this.closed = true;
        try { this.socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0))); } catch { /* ignore */ }
        this.socket.end();
        this._emit('close');
        return;
      }

      if (opcode === OP.CONT) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }

      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        const op = this.fragmentOpcode ?? opcode;
        this.fragmentOpcode = null;
        this._emit('message', op === OP.TEXT ? full.toString('utf8') : full);
      }
    }
  }
}

export const OPCODES = OP;
