import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const versions = {
  'thread-owner-discovery': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-following-status-requested': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-read-model-settings': 1,
  'thread-follower-update-thread-settings': 2,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-submit-user-input': 1,
};

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  constructor(onMessage, maxBytes = 128 * 1024 * 1024) {
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.header = Buffer.alloc(4);
    this.headerBytes = 0;
    this.body = null;
    this.bodyBytes = 0;
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) return;
        const size = this.header.readUInt32LE(0);
        if (!size || size > this.maxBytes) throw new Error('IPC 帧超出限制');
        // Image-heavy desktop snapshots can exceed 64 MiB. Allocate once:
        // repeatedly concatenating network chunks copies the whole prefix and
        // makes receiving a large snapshot quadratic in time and memory traffic.
        this.body = Buffer.allocUnsafe(size);
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count; offset += count;
      if (this.bodyBytes === this.body.length) {
        const body = this.body;
        this.body = null; this.bodyBytes = 0; this.headerBytes = 0;
        this.onMessage(JSON.parse(body.toString('utf8')));
      }
    }
  }
}

export class DesktopIpc extends EventEmitter {
  constructor({ pipe = '\\\\.\\pipe\\codex-ipc' } = {}) {
    super();
    this.pipe = pipe;
    this.clientId = null;
    this.pending = new Map();
    this.closed = false;
  }
  connect() {
    if (this.closed || this.socket) return;
    const socket = net.createConnection(this.pipe);
    this.socket = socket;
    const reader = new FrameReader(m => this.handle(m));
    socket.on('data', chunk => {
      try { reader.push(chunk); } catch (err) { this.emit('diagnostic', err.message); socket.destroy(); }
    });
    socket.on('connect', async () => {
      try {
        const reply = await this.request('initialize', { clientType: 'remote-coding' });
        this.clientId = reply.result.clientId;
        this.emit('connected');
      } catch (err) { this.emit('diagnostic', err.message); socket.destroy(); }
    });
    socket.on('error', err => this.emit('diagnostic', err.code || err.message));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('桌面连接已断开')); }
      this.pending.clear();
      this.emit('disconnected');
      if (!this.closed) this.retry = setTimeout(() => this.connect(), 2000);
    });
  }
  send(message) {
    if (!this.socket?.writable) throw new Error('Codex 桌面尚未连接');
    this.socket.write(frame(message));
  }
  request(method, params, { targetClientId, hostId, timeoutMs = 8000 } = {}) {
    if (!this.clientId && method !== 'initialize') return Promise.reject(new Error('Codex 桌面尚未连接'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const e = new Error('桌面请求超时；结果可能已生效，请先查看会话，勿重复发送');
        e.unknown = true;
        reject(e);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        const version = (versions[method] || 0) + (hostId && hostId !== 'local' && method.startsWith('thread-follower-') ? 1 : 0);
        this.send({ type: 'request', requestId, sourceClientId: this.clientId || 'initializing-client',
          version, method, params, targetClientId, hostId: hostId === 'local' ? undefined : hostId, timeoutMs });
      } catch (err) { clearTimeout(timer); this.pending.delete(requestId); reject(err); }
    });
  }
  broadcast(method, params, targetClientIds) {
    if (!this.clientId) throw new Error('Codex 桌面尚未连接');
    this.send({ type: 'broadcast', method, params, sourceClientId: this.clientId,
      version: versions[method] || 0, targetClientIds });
  }
  handle(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === 'error') pending.reject(new Error(message.error || '桌面请求失败'));
      else pending.resolve(message);
    } else if (message.type === 'broadcast') {
      if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
      this.emit('broadcast', message);
    } else if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'request') {
      this.send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-handler-for-request' });
    }
  }
  async owner(conversationId, hostId = 'local') {
    const response = await this.request('thread-owner-discovery', { conversationId, hostId });
    return response.handledByClientId;
  }
  follow(conversationId, hostId, following, owner) {
    this.broadcast('thread-stream-following-changed', { conversationId, hostId, following }, owner ? [owner] : undefined);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }
}
