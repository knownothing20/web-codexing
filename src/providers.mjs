import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class ClaudeChannels extends EventEmitter {
  constructor() { super(); this.channels = new Map(); }
  register({ id, name }) {
    if (!/^[0-9a-f-]{36}$/.test(id || '') || typeof name !== 'string') throw new Error('通道格式无效');
    let channel = this.channels.get(id);
    if (!channel) {
      if (this.channels.size >= 16) throw new Error('Claude 通道数量已满');
      channel = { id, name: name.slice(0, 80), seen: Date.now(), messages: [], queue: [], listeners: new Set() };
      this.channels.set(id, channel);
    }
    channel.seen = Date.now(); channel.name = name.slice(0, 80);
    this.publish(channel); return channel;
  }
  online(channel) { return Date.now() - channel.seen < 45000; }
  list(query = '') { return [...this.channels.values()].filter(c => c.name.toLowerCase().includes(query.toLowerCase())).map(c => ({ id: c.id, title: c.name, project: 'Claude Code 通道', updatedAt: c.seen, online: this.online(c) })); }
  get(id) { const channel = this.channels.get(id); if (!channel) throw new Error('Claude 通道不存在'); return channel; }
  view(channel) { return { type: 'snapshot', title: channel.name, connected: this.online(channel), writable: this.online(channel), busy: false,
    model: 'Claude Code', effort: '', requests: [], messages: channel.messages, order: channel.messages.map(m => m.id), turnIds: [] }; }
  publish(channel) { for (const fn of channel.listeners) fn(this.view(channel)); }
  subscribe(id, listener) { const channel = this.get(id); channel.listeners.add(listener); listener(this.view(channel));
    const timer = setInterval(() => { if (!this.online(channel)) listener({ type: 'connection', connected: false, writable: false, message: 'Claude Code 通道离线，历史仍可查看' }); }, 15000);
    return () => { clearInterval(timer); channel.listeners.delete(listener); }; }
  send(id, text, messageId) {
    const channel = this.get(id); if (!this.online(channel)) throw new Error('Claude Code 通道离线');
    if (!channel.messages.some(m => m.id === messageId)) {
      if (channel.queue.length >= 32) throw new Error('Claude 待处理消息过多');
      channel.messages.push({ id: messageId, turnId: '', role: 'user', text, kind: 'message', at: Date.now(), timeSource: 'recorded' });
      channel.queue.push({ id: messageId, text }); channel.messages = channel.messages.slice(-120); this.publish(channel);
    }
    return { accepted: true, pending: true, messageId };
  }
  next(id, acknowledged) {
    const channel = this.get(id), wasOnline = this.online(channel); channel.seen = Date.now();
    if (!wasOnline) this.publish(channel);
    if (acknowledged) channel.queue = channel.queue.filter(m => m.id !== acknowledged);
    return channel.queue[0] || null;
  }
  reply(id, messageId, text) {
    const channel = this.get(id); if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('回复格式无效');
    if (!channel.messages.some(m => m.id === messageId && m.role === 'user')) throw new Error('原消息不存在');
    channel.seen = Date.now(); channel.messages.push({ id: randomUUID(), turnId: '', role: 'assistant', text, phase: 'final_answer', kind: 'message', at: Date.now(), timeSource: 'recorded' });
    channel.messages = channel.messages.slice(-120); this.publish(channel); return { ok: true };
  }
}

export class WorkBuddy {
  constructor({ token = process.env.REMOTE_CODING_WORKBUDDY_ACCESS_TOKEN, base = 'https://www.workbuddy.cn' } = {}) { this.token = token; this.base = base; }
  get configured() { return !!this.token; }
  async call(path, options = {}) {
    if (!this.configured) throw new Error('WorkBuddy 尚未配置官方接口授权');
    let response;
    try { response = await fetch(this.base + '/openapi/v2' + path, { ...options,
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) }); }
    catch { const error = new Error('WorkBuddy 网络连接失败，请稍后重试'); error.unknown = options.method === 'POST'; throw error; }
    if ([401, 403].includes(response.status)) throw new Error('WorkBuddy 授权失效，请在电脑更新官方授权');
    if (!response.ok) { const error = new Error('WorkBuddy 接口暂不可用'); error.unknown = options.method === 'POST' && response.status >= 500; throw error; }
    let result;
    try { result = await response.json(); } catch { const error = new Error('WorkBuddy 接口返回格式无法识别'); error.unknown = options.method === 'POST'; throw error; }
    if (result.code !== undefined && result.code !== 0) throw new Error('WorkBuddy 接口未接受请求，请检查电脑上的官方授权');
    return result.data || result;
  }
  async status() { return this.configured ? this.call('/localassistant') : { online: false }; }
  async history(before = 0) {
    const result = await this.call('/localassistant/message?limit=60&offset=' + Math.max(0, Number(before) || 0));
    const messages = (result.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({
      id: m.message_id, role: m.role, turnId: '', kind: 'message', phase: 'final_answer',
      text: (m.content || []).map(c => typeof c === 'string' ? c : typeof c.text === 'string' ? c.text : '').join('\n'),
      at: Date.parse(m.created_at) || null, timeSource: 'recorded',
    })).filter(m => m.text).sort((a, b) => (a.at || 0) - (b.at || 0));
    return { messages, cursor: (result.messages || []).length === 60 ? (Number(before) || 0) + 60 : null };
  }
  async send(text) { const result = await this.call('/localassistant/message', { method: 'POST', body: JSON.stringify({ content: text, msg_type: 'text' }) }); return { accepted: true, messageId: result.message_id }; }
}
