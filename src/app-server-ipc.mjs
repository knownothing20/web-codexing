import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const OWNER = 'shared-app-server';
const MAX_TURNS = 24;
const MAX_SUBSCRIPTIONS = 32;
const approvalMethods = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput',
]);
const threadEvents = new Set([
  'serverRequest/resolved', 'thread/status/changed', 'thread/settings/updated',
  'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta',
]);
const mutations = new Set(['turn/start', 'turn/steer', 'turn/interrupt', 'thread/settings/update']);

export function localAppServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !url.port) {
    throw new Error('App Server 地址须使用本机回环 WebSocket 和明确端口');
  }
  return url.href;
}

// The configured endpoint is the owner used by both windows. This client never
// starts an alternative App Server or opens a second writer on the chat store.
export class AppServerIpc extends EventEmitter {
  constructor({ url, token, connectSocket = (address, options) => new WebSocket(address, options), retryMs = 2000 }) {
    super();
    this.url = localAppServerUrl(url);
    this.connectSocket = connectSocket;
    this.options = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    this.retryMs = retryMs;
    this.pending = new Map();
    this.following = new Map();
    this.clientId = null;
    this.closed = false;
  }

  connect() {
    if (this.closed || this.socket) return;
    const socket = this.connectSocket(this.url, this.options);
    this.socket = socket;
    this.connectTimer = setTimeout(() => socket.close(), 8000);
    this.connectTimer.unref?.();
    socket.addEventListener('open', async () => {
      try {
        await this.call('initialize', {
          clientInfo: { name: 'web_codexing', title: 'Remote Coding', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        if (this.socket !== socket || this.closed) return;
        this.write({ method: 'initialized' });
        clearTimeout(this.connectTimer);
        this.clientId = OWNER;
        this.emit('connected');
      } catch { socket.close(); }
    });
    socket.addEventListener('message', event => {
      if (this.socket === socket && typeof event.data === 'string') {
        if (event.data.length > 128 * 1024 * 1024) socket.close();
        else this.receive(event.data);
      }
    });
    socket.addEventListener('close', () => this.disconnect(socket));
  }

  disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clientId = null;
    clearTimeout(this.connectTimer);
    for (const pending of this.pending.values()) pending.fail('App Server 连接断开');
    this.pending.clear();
    this.following.clear();
    this.emit('disconnected');
    if (!this.closed) this.retry = setTimeout(() => this.connect(), this.retryMs);
  }

  write(message) {
    if (this.socket?.readyState !== 1) throw new Error('App Server 尚未连接');
    this.socket.send(JSON.stringify(message));
  }

  call(method, params, timeoutMs = 8000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        error ? reject(error) : resolve(result);
      };
      const fail = message => {
        const error = new Error(message);
        if (mutations.has(method)) error.unknown = true;
        finish(error);
      };
      const timer = setTimeout(() => fail('App Server 请求超时，请先核对会话状态'), timeoutMs);
      this.pending.set(id, { fail, finish });
      try { this.write({ id, method, params }); }
      catch (error) { finish(error); }
    });
  }

  async owner(threadId) {
    if (!this.clientId) return null;
    const { thread } = await this.call('thread/read', { threadId, includeTurns: false });
    return thread?.id === threadId && ['active', 'idle', 'systemError'].includes(thread.status?.type) ? OWNER : null;
  }

  follow(threadId, hostId, enabled) {
    if (hostId !== 'local' || !this.clientId) return;
    const previous = this.following.get(threadId);
    if (!enabled) {
      if (!previous) return;
      this.following.delete(threadId);
      this.call('thread/unsubscribe', { threadId }).catch(() => {});
      return;
    }
    if (previous?.state) return this.publish(previous, true);
    if (previous || this.following.size >= MAX_SUBSCRIPTIONS) return;
    const entry = { id: threadId, revision: 0, state: null, backlog: [], requests: new Map() };
    this.following.set(threadId, entry);
    this.hydrate(entry).catch(() => {
      if (this.following.get(threadId) !== entry) return;
      this.follow(threadId, 'local', false);
    });
  }

  async hydrate(entry) {
    const threadId = entry.id;
    const resumed = await this.call('thread/resume', { threadId, excludeTurns: true });
    if (this.following.get(threadId) !== entry) return;
    if (resumed.thread?.id !== threadId) throw new Error('App Server 返回了不同的会话');
    const page = await this.call('thread/turns/list', { threadId, limit: MAX_TURNS, itemsView: 'full' });
    if (this.following.get(threadId) !== entry) return;
    if (!Array.isArray(page.data)) throw new Error('App Server 未返回会话历史');
    entry.state = {
      id: threadId, title: resumed.thread.name || resumed.thread.preview, cwd: resumed.cwd,
      latestModel: resumed.model, latestReasoningEffort: resumed.reasoningEffort || '',
      latestThreadSettings: Object.hasOwn(resumed, 'serviceTier') ? { serviceTier: resumed.serviceTier } : {},
      threadRuntimeStatus: resumed.thread.status,
      turns: page.data.slice().reverse().map(turn => this.turn(turn)), requests: [],
    };
    // Persisted history can already contain the events received while it loaded.
    // Replay structural events to catch newer state, but let item/completed take
    // precedence over any ambiguous deltas in that initial window.
    for (const event of entry.backlog) {
      if (event.method !== 'item/agentMessage/delta' && event.method !== 'item/started' &&
          !(event.method === 'turn/started' && entry.state.turns.some(t =>
            t.turnId === event.params.turn?.id && t.status !== 'inProgress'))) this.apply(entry, event);
    }
    entry.backlog = [];
    this.publish(entry, true);
  }

  turn(turn) { return { ...turn, turnId: turn.id, items: turn.items || [] }; }

  receive(data) {
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (!event.method) {
      const pending = this.pending.get(event.id);
      if (pending) pending.finish(event.error ? new Error(event.error.message || 'App Server 请求失败') : null, event.result);
      return;
    }
    if (!approvalMethods.has(event.method) && !threadEvents.has(event.method)) return;
    const entry = this.following.get(event.params?.threadId);
    if (!entry) return;
    if (!entry.state) {
      if (entry.backlog.length < 512) entry.backlog.push(event);
      else this.socket?.close();
      return;
    }
    if (this.apply(entry, event)) this.publish(entry);
  }

  apply(entry, { id, method, params }) {
    const state = entry.state;
    if (approvalMethods.has(method) && id != null) {
      const key = 'app-server:' + JSON.stringify(id);
      entry.requests.set(key, { id: key, wireId: id, method, params });
      state.requests = [...entry.requests.values()];
    } else if (method === 'serverRequest/resolved') {
      entry.requests.delete('app-server:' + JSON.stringify(params.requestId));
      state.requests = [...entry.requests.values()];
    } else if (method === 'thread/status/changed') {
      state.threadRuntimeStatus = params.status;
    } else if (method === 'thread/settings/updated') {
      const settings = params.threadSettings;
      if (settings?.model) state.latestModel = settings.model;
      if (settings?.effort) state.latestReasoningEffort = settings.effort;
      if (Object.hasOwn(settings || {}, 'serviceTier')) state.latestThreadSettings = { serviceTier: settings.serviceTier };
    } else if (method === 'turn/started' || method === 'turn/completed') {
      if (!params.turn?.id) return false;
      const index = state.turns.findIndex(turn => turn.turnId === params.turn.id);
      const turn = this.turn(params.turn);
      if (index === -1) state.turns.push(turn);
      else {
        if (!turn.items.length) turn.items = state.turns[index].items;
        state.turns[index] = turn;
      }
      state.turns = state.turns.slice(-MAX_TURNS);
    } else if (['item/started', 'item/completed', 'item/agentMessage/delta'].includes(method)) {
      const turn = state.turns.find(t => t.turnId === params.turnId);
      if (!turn) return false;
      if (method === 'item/agentMessage/delta') {
        let item = turn.items.find(item => item.id === params.itemId);
        if (!item) {
          item = { type: 'agentMessage', id: params.itemId, text: '' };
          turn.items.push(item);
        }
        if (item.type === 'agentMessage') item.text += params.delta;
      } else {
        if (!params.item?.id) return false;
        const index = turn.items.findIndex(item => item.id === params.item.id);
        if (index === -1) turn.items.push(params.item);
        else turn.items[index] = params.item;
      }
    } else return false;
    return true;
  }

  publish(entry, snapshot = false) {
    const baseRevision = entry.revision++;
    const change = snapshot ? { type: 'snapshot', conversationState: entry.state, revision: entry.revision } : {
      type: 'patches', baseRevision, revision: entry.revision,
      patches: [{ op: 'replace', path: [], value: entry.state }],
    };
    this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: OWNER,
      params: { conversationId: entry.id, hostId: 'local', change } });
  }

  async request(method, params, { hostId = 'local', timeoutMs } = {}) {
    if (!this.clientId || hostId !== 'local') throw new Error('App Server 尚未连接此主机');
    const threadId = params.conversationId;
    if (method === 'thread-owner-discovery') return { handledByClientId: await this.owner(threadId) };
    const entry = this.following.get(threadId);
    if (!entry?.state) throw new Error('请先同步这条会话');
    const state = entry.state;
    const latest = state.turns.at(-1);
    const call = async (rpc, input) => ({ result: await this.call(rpc, { threadId, ...input }, timeoutMs) });
    switch (method) {
      case 'thread-follower-start-turn': {
        const { input, clientUserMessageId } = params.turnStart.request;
        if (state.threadRuntimeStatus?.type === 'active' || latest?.status === 'inProgress') throw new Error('当前轮次尚未完成');
        return call('turn/start', { input, clientUserMessageId });
      }
      case 'thread-follower-steer-turn': {
        if (latest?.status !== 'inProgress') throw new Error('当前轮次已结束');
        return call('turn/steer', { input: params.input, expectedTurnId: latest.turnId });
      }
      case 'thread-follower-interrupt-turn':
        return call('turn/interrupt', { turnId: params.expectedTurnId });
      case 'thread-follower-update-thread-settings': {
        if ((state.latestModel || null) !== params.condition.ifModelEquals ||
            (state.latestReasoningEffort || null) !== params.condition.ifEffortEquals) throw new Error('模型设置已变化，请重新打开');
        await call('thread/settings/update', params.threadSettings);
        return { result: { applied: true } };
      }
      case 'thread-follower-read-model-settings': {
        const result = await this.call('thread/resume', { threadId, excludeTurns: true }, timeoutMs);
        return { result: { settings: { model: result.model, reasoningEffort: result.reasoningEffort || '' } } };
      }
      default: {
        const request = entry.requests.get(params.requestId);
        const expected = {
          'thread-follower-command-approval-decision': 'item/commandExecution/requestApproval',
          'thread-follower-file-approval-decision': 'item/fileChange/requestApproval',
          'thread-follower-submit-user-input': 'item/tool/requestUserInput',
        }[method];
        if (!expected || request?.method !== expected) throw new Error('操作已结束或当前通道不支持');
        this.write({ id: request.wireId, result: params.response || { decision: params.decision } });
        entry.requests.delete(params.requestId);
        state.requests = [...entry.requests.values()];
        return { result: { submitted: true } };
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.connectTimer);
    this.socket?.close();
  }
}
