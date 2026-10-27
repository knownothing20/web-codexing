import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces, hostname } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { DesktopIpc } from './ipc.mjs';
import { Catalog } from './catalog.mjs';
import { Bridge } from './bridge.mjs';
import { getModels, getSkills } from './models.mjs';
import { PairStore } from './pair-store.mjs';
import { ImageStore, serveVideo } from './attachments.mjs';
import { ClaudeChannels, WorkBuddy } from './providers.mjs';
import { DesktopOpener } from './desktop-open.mjs';
import { getQuota } from './quota.mjs';
import { allowedAddress } from './network.mjs';
import { ListStatus } from './list-status.mjs';
import { ActivityFeed } from './activity.mjs';
import { UploadStore, MAX_UPLOAD } from './uploads.mjs';
import { ForkService } from './forks.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = process.env.REMOTE_CODING_RUNTIME_DIR || join(root, '.local');
mkdirSync(runtimeDir, { recursive: true });
const catalog = new Catalog();
const ipc = new DesktopIpc({ pipe: process.env.REMOTE_CODING_IPC_PIPE || '\\\\.\\pipe\\codex-ipc' });
const images = new ImageStore();
const uploads = new UploadStore(runtimeDir), forks = new ForkService(runtimeDir);
let uploadReaders = 0;
const bridge = new Bridge(ipc, catalog, images);
const listStatus = new ListStatus(bridge,catalog);
const activity = new ActivityFeed(catalog,listStatus);
const desktopOpener = new DesktopOpener({ enabled: process.platform === 'win32' && process.env.REMOTE_CODING_DISABLE_DESKTOP_OPEN !== '1' });
const claude = new ClaudeChannels(), workbuddy = new WorkBuddy();
const integrationsEnabled = process.env.REMOTE_CODING_EXPERIMENTAL_INTEGRATIONS === '1';
let pairCode = String(randomInt(100000, 1000000));
const localKey = randomBytes(24).toString('hex');
const pairStore = new PairStore(runtimeDir);
let authMode = 'paired';
try { if (JSON.parse(readFileSync(join(runtimeDir, 'settings.json'), 'utf8')).authMode === 'lan') authMode = 'lan'; } catch {}
const sessions = new Map();
const pairAttempts = new Map();
const sends = new Map();
const streams = new Set();
const lanIps = [...new Set(Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal && privateIp(n.address)).map(n => n.address))];
const tls = process.env.REMOTE_CODING_TLS_PFX ? { pfx: readFileSync(process.env.REMOTE_CODING_TLS_PFX), passphrase: process.env.REMOTE_CODING_TLS_PASSWORD } : null;
const protocol = tls ? 'https' : 'http';
let port;
let urls;
const staticFiles = new Map([
  ['/inline-format.js', ['inline-format.js', 'text/javascript; charset=utf-8']],
  ['/outbox.js', ['outbox.js', 'text/javascript; charset=utf-8']],
  ['/clipboard.js', ['clipboard.js', 'text/javascript; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/read-state.js', ['read-state.js', 'text/javascript; charset=utf-8']],
  ['/service-tier.js', ['service-tier.js', 'text/javascript; charset=utf-8']],
  ['/notifications.js', ['notifications.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
function privateIp(ip) {
  return allowedAddress(ip, { tailscale: process.env.REMOTE_CODING_TAILSCALE === '1' });
}
function loopback(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function validHost(req) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, ...lanIps.map(ip => `${ip}:${port}`)].includes(req.headers.host);
}
function sameOrigin(req) { return !req.headers.origin || req.headers.origin === `${protocol}://${req.headers.host}`; }
function session(req) {
  if (authMode === 'lan') {
    const sid = 'lan:' + req.socket.remoteAddress;
    if (!sessions.has(sid)) sessions.set(sid, { csrf: randomBytes(24).toString('hex'), expires: Date.now() + 12 * 3600000, anonymous: true });
    const value = sessions.get(sid); if (value.expires < Date.now()) { sessions.delete(sid); return session(req); }
    return { ...value, sid };
  }
  const sid = /(?:^|;\s*)rc_session=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  let s = sid ? sessions.get(sid) : null;
  if (!s && sid) {
    const remembered = pairStore.get(sid);
    if (remembered) { s = { csrf: randomBytes(24).toString('hex'), expires: remembered.expires, remembered: true }; sessions.set(sid, s); }
  }
  if (!s || s.expires < Date.now()) return null;
  return { ...s, sid };
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function writeRuntime() {
  writeFileSync(join(runtimeDir, 'runtime.json'), JSON.stringify({
    pid: process.pid, port, protocol, urls, pairCode, localKey, authMode, startedAt: Date.now(), computer: hostname(),
  }, null, 2));
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!privateIp(req.socket.remoteAddress || '') || !validHost(req)) return json(res, 403, { error: '仅允许本机和局域网访问' });
  if (!sameOrigin(req)) return json(res, 403, { error: '禁止跨站访问' });
  const url = new URL(req.url, `${protocol}://${req.headers.host}`);
  const path = url.pathname;
  if (req.method === 'GET' && staticFiles.has(path)) {
    const [file, type] = staticFiles.get(path);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': path === '/' ? 'no-cache' : 'public, max-age=86400' });
    return res.end(readFileSync(join(root, 'public', file)));
  }
  if (req.method === 'GET' && path === '/health') return json(res, 200, { app: 'remote-coding', ready: true });
  if (path.startsWith('/api/local/')) {
    if (!loopback(req) || req.headers['x-local-key'] !== localKey) return json(res, 403, { error: '仅供电脑控制面板使用' });
    if (path === '/api/local/status') return json(res, 200, { connected: !!ipc.clientId, phones: sessions.size,
      streams: streams.size, remembered: pairStore.devices.size, authMode, memoryMb: Math.round(process.memoryUsage().rss / 1048576), pid: process.pid });
    if (req.method === 'POST' && path.startsWith('/api/local/claude/')) {
      if (!integrationsEnabled) return json(res, 409, { error: '当前版本只启用 Codex' });
      const data = await body(req), action = path.split('/').at(-1);
      if (action === 'register') { claude.register(data); return json(res, 200, { ok: true }); }
      if (action === 'next') return json(res, 200, { message: claude.next(data.id, data.acknowledged) });
      if (action === 'reply') return json(res, 200, claude.reply(data.id, data.message_id, data.text));
      return json(res, 404, { error: '通道接口不存在' });
    }
    if (path === '/api/local/qr') {
      const address = url.searchParams.get('url') || urls[0];
      if (!urls.includes(address)) return json(res, 400, { error: '地址无效' });
      const png = await QRCode.toBuffer(authMode === 'lan' ? `${address}/` : `${address}/#pair=${pairCode}`, { width: 260, margin: 2, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    if (req.method === 'POST' && path === '/api/local/exit') {
      json(res, 200, { ok: true }); setTimeout(shutdown, 150); return;
    }
    if (req.method === 'POST' && path === '/api/local/revoke-devices') {
      pairStore.clear(); sessions.clear(); pairCode = String(randomInt(100000, 1000000)); writeRuntime();
      for (const stream of streams) stream.close();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/local/auth-mode') {
      const data = await body(req);
      if (!['paired', 'lan'].includes(data.mode)) return json(res, 400, { error: '连接模式无效' });
      authMode = data.mode;
      writeFileSync(join(runtimeDir, 'settings.json'), JSON.stringify({ authMode }));
      sessions.clear(); for (const stream of streams) stream.close(); writeRuntime();
      return json(res, 200, { ok: true, authMode });
    }
    return json(res, 404, { error: '接口不存在' });
  }
  if (path === '/api/pair' && req.method === 'POST') {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    const attempt = pairAttempts.get(ip) || { count: 0, until: now + 60000 };
    if (attempt.until < now) { attempt.count = 0; attempt.until = now + 60000; }
    pairAttempts.set(ip, attempt);
    if (++attempt.count > 8 || sessions.size >= 32) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
    const data = await body(req);
    const code = String(data.code || '');
    if (code.length !== pairCode.length || !timingSafeEqual(Buffer.from(code), Buffer.from(pairCode))) return json(res, 401, { error: '配对码不正确，请查看电脑控制面板' });
    const sid = randomBytes(32).toString('hex');
    const duration = data.remember === true ? 30 * 24 * 3600000 : 12 * 3600000;
    sessions.set(sid, { csrf: randomBytes(24).toString('hex'), expires: now + duration, remembered: data.remember === true });
    if (data.remember === true) pairStore.remember(sid, now + duration);
    res.setHeader('Set-Cookie', `rc_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${duration / 1000}${tls ? '; Secure' : ''}`);
    return json(res, 200, { ok: true, remembered: data.remember === true });
  }
  const s = session(req);
  if (!s) return json(res, 401, { error: '请先与电脑配对' });
  if (!['GET','HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== s.csrf) return json(res, 403, { error: '会话校验失败，请刷新页面' });
  if (req.method === 'GET' && path === '/api/status') return json(res, 200, {
    csrf: s.csrf, connected: !!ipc.clientId, computer: hostname(), authMode, remembered: !!s.remembered, transport: tls ? 'https' : 'lan-http',
    features: { live: true, send: true, stop: true, approvals: true, userInput: true, images: true, videos: true, uploads:true, fork:true, skills: true, references: true, openDesktop: desktopOpener.enabled, create: false },
  });
  if (req.method === 'GET' && path === '/api/quota') {
    if (process.env.REMOTE_CODING_DISABLE_ACCOUNT_QUOTA === '1') return json(res, 503, { error: '测试环境未启用账号额度读取' });
    try { return json(res, 200, await getQuota()); }
    catch (err) { return json(res, 503, { error: err.message }); }
  }
  if (req.method === 'POST' && path === '/api/logout') {
    sessions.delete(s.sid);
    if (!s.anonymous) pairStore.forget(s.sid);
    for (const stream of streams) if (stream.sid === s.sid) stream.close();
    res.setHeader('Set-Cookie', 'rc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/api/threads') {
    const offset = Math.max(0, Math.min(10000, Number(url.searchParams.get('offset')) || 0));
    const since = url.searchParams.get('recentDays') === '7' ? Date.now() - 7 * 86400000 : 0;
    const threads = catalog.list({ offset, search: (url.searchParams.get('q') || '').slice(0, 80), since });
    const statuses=new Map(listStatus.read(threads.map(t=>t.id),{observe:false}).map(t=>[t.id,t]));
    for(const thread of threads)Object.assign(thread,statuses.get(thread.id));
    return json(res, 200, { threads, next: threads.length === 40 ? offset + 40 : null });
  }
  if(req.method==='POST' && path==='/api/thread-statuses') {
    const data=await body(req);
    if(!Array.isArray(data.ids)||data.ids.length>120||data.ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)))return json(res,400,{error:'最多查询 120 条会话状态'});
    return json(res,200,{threads:await listStatus.refresh(data.ids)});
  }
  if (req.method === 'GET' && path === '/api/models') return json(res, 200, await getModels());
  if (req.method === 'GET' && path === '/api/providers') return json(res, 200, { providers: [
    { id: 'codex', name: 'Codex', configured: true, connected: !!ipc.clientId },
    { id: 'claude', name: 'Claude Code', configured: true, connected: claude.list().some(c => c.online),
      description: '等待电脑启用 Claude Code 消息通道。通道接通后可收发消息；现有桌面历史不会自动导入，审批仍在电脑处理。', docs: 'https://code.claude.com/docs/en/channels-reference' },
    { id: 'workbuddy', name: 'WorkBuddy', configured: workbuddy.configured, connected: false,
      description: '需要在电脑配置 WorkBuddy 官方接口授权。支持本地助理收发消息和历史，经过 WorkBuddy 云端。', docs: 'https://open.workbuddy.cn/docs/openapi' },
  ].filter(provider => integrationsEnabled || provider.id === 'codex') });
  const providerMatch = /^\/api\/providers\/(claude|workbuddy)(?:\/threads(?:\/([0-9a-z-]+)\/(history|events|send))?)?$/.exec(path);
  if (providerMatch) {
    if (!integrationsEnabled) return json(res, 409, { error: '当前版本只启用 Codex' });
    const [, provider, threadId, action] = providerMatch;
    const query = (url.searchParams.get('q') || '').slice(0, 80);
    if (!action && req.method === 'GET') {
      if (provider === 'claude') return json(res, 200, { threads: claude.list(query), next: null });
      if (!workbuddy.configured) return json(res, 200, { threads: [], next: null });
      const status = await workbuddy.status();
      return json(res, 200, { threads: [{ id: 'local-assistant', title: 'WorkBuddy 本地助理', project: status.online ? '电脑在线' : '电脑离线', updatedAt: Date.now() }], next: null });
    }
    if (provider === 'workbuddy' && threadId !== 'local-assistant') return json(res, 404, { error: '本地助理会话不存在' });
    if (action === 'history' && req.method === 'GET') return json(res, 200, provider === 'claude' ? { messages: claude.get(threadId).messages, cursor: null } : await workbuddy.history(url.searchParams.get('before')));
    if (action === 'send' && req.method === 'POST') {
      const data = await body(req);
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000 || !/^[0-9a-f-]{36}$/.test(data.messageId || '')) return json(res, 400, { error: '请输入 1–8000 字的消息' });
      const key = `${s.sid}:${provider}:${threadId}:${data.messageId}`;
      if (!sends.has(key)) {
        if (sends.size >= 512) return json(res, 429, { error: '发送记录已满，请重启桥接程序' });
        const send = async () => {
          if (provider === 'claude') return claude.send(threadId, data.text.trim(), data.messageId);
          const status = await workbuddy.status(); if (!status.online) throw new Error('WorkBuddy 电脑助理离线');
          return workbuddy.send(data.text.trim());
        };
        sends.set(key, send().then(result => ({ result }), err => ({ error: err.message, unknown: !!err.unknown })));
      }
      const outcome = await sends.get(key); return json(res, outcome.error ? 409 : 200, outcome.error ? outcome : outcome.result);
    }
    if (action === 'events' && req.method === 'GET') {
      if (streams.size >= 16) return json(res, 429, { error: '连接过多' });
      if (provider === 'claude') claude.get(threadId);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      let closed = false, unsubscribe, pollTimer, polling = false;
      const send = data => { if (!closed && res.writableLength < 512 * 1024) res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const stream = { sid: s.sid, close: () => { if (closed) return; closed = true; clearInterval(heartbeat); clearInterval(pollTimer); unsubscribe?.(); streams.delete(stream); res.end(); } };
      const heartbeat = setInterval(() => { if (!session(req)) return stream.close(); if (!closed) res.write(': ping\n\n'); }, 20000);
      streams.add(stream); req.on('close', stream.close);
      if (provider === 'claude') unsubscribe = claude.subscribe(threadId, send);
      else {
        const poll = async () => {
          if (polling || closed) return; polling = true;
          try {
            const [status, page] = await Promise.all([workbuddy.status(), workbuddy.history()]);
            if (!status.online) send({ type: 'connection', connected: false, writable: false, message: 'WorkBuddy 电脑助理离线，历史仍可查看' });
            else send({ type: 'snapshot', connected: true, writable: true, busy: false, title: 'WorkBuddy 本地助理', model: 'WorkBuddy', requests: [], messages: page.messages, order: page.messages.map(m => m.id), turnIds: [] });
          } catch (err) { send({ type: 'connection', writable: false, connected: false, message: err.message }); }
          finally { polling = false; }
        };
        pollTimer = setInterval(poll, 15000); poll();
      }
      return;
    }
    return json(res, 405, { error: '操作不支持' });
  }
  if (req.method === 'GET' && /^\/api\/images\/[0-9a-f]{64}$/.test(path)) {
    try {
      const image = await (url.searchParams.get('size')==='thumb'?images.thumbnail(path.split('/').at(-1)):images.read(path.split('/').at(-1)));
      res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=300', 'Content-Length': image.bytes.length });
      return res.end(image.bytes);
    } catch (err) { return json(res, 404, { error: err.message }); }
  }
  if (['GET','HEAD'].includes(req.method) && /^\/api\/videos\/[0-9a-f]{64}$/.test(path)) {
    try { await serveVideo(req,res,images,path.split('/').at(-1),{download:url.searchParams.get('download')==='1'}); }
    catch(err){if(res.headersSent)res.destroy();else return json(res,404,{error:err.message});}
    return;
  }
  if (path === '/api/uploads' && req.method === 'POST') {
    const threadId = url.searchParams.get('threadId');
    if (!catalog.get(threadId)) return json(res,404,{error:'请先选择一条有效会话'});
    if (uploadReaders >= 2) return json(res,429,{error:'正在接收附件，请稍后重试'});
    uploadReaders++;
    try {
      let size=0; const chunks=[];
      for await (const chunk of req) { size+=chunk.length; if (size>MAX_UPLOAD) throw new Error('每个附件最多 20 MB'); chunks.push(chunk); }
      return json(res,200,await uploads.add({sid:s.sid,threadId,name:url.searchParams.get('name'),image:url.searchParams.get('image')==='1',bytes:Buffer.concat(chunks)}));
    } finally { uploadReaders--; }
  }
  if (/^\/api\/uploads\/[0-9a-f-]{36}$/.test(path) && req.method === 'DELETE') { uploads.remove(path.split('/').at(-1),s.sid); return json(res,200,{ok:true}); }
  const match = /^\/api\/threads\/([0-9a-f-]{36})\/(history|events|send|stop|approval|input|settings|skills|open-desktop|fork)$/.exec(path);
  if (!match) return json(res, 404, { error: '接口不存在' });
  const [, id, action] = match;
  if (action === 'skills' && req.method === 'GET') {
    const row = catalog.get(id); if (!row) return json(res, 404, { error: '会话不存在' });
    const result = await getSkills(row.cwd);
    return json(res, 200, { ...result, skills: result.skills.map(({ path, ...skill }) => skill) });
  }
  if (action === 'history' && req.method === 'GET') {
    const beforeValue = url.searchParams.get('before');
    const before = beforeValue === null ? null : Number(beforeValue);
    if (before !== null && (!Number.isSafeInteger(before) || before < 0)) return json(res, 400, { error: '历史游标无效' });
    const page = catalog.historyPage(id, before);
    const turn=catalog.turnStatus?.get(id);
    const completionKey=turn?.status==='completed' ? turn.turn_id || 'record:'+turn.rollout_ordinal : null;
    return json(res, 200, { ...page, completionKey, messages: page.messages.map(m => images.project(m, id)) });
  }
  if (action === 'events' && req.method === 'GET') {
    if (streams.size >= 16) return json(res, 429, { error: '连接过多' });
    if (!catalog.get(id)) return json(res, 404, { error: '会话不存在' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false, unsubscribe, stopActivity;
    const cleanup = () => {
      if (closed) return; closed = true;
      clearInterval(heartbeat);listStatus.off('change',sendStatuses); stopActivity?.(); unsubscribe?.(); streams.delete(stream); res.end();
    };
    const stream = { sid: s.sid, close: cleanup };
    streams.add(stream);
    const send = data => {
      if (closed) return;
      if (res.writableLength > 512 * 1024) return cleanup();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const sendStatuses=threads=>send({type:'list-status',threads});
    listStatus.on('change',sendStatuses);
    const heartbeat = setInterval(() => {
      if (!session(req)) return cleanup();
      activity.reconcile();
      res.write(': ping\n\n');
    }, 20000);
    req.on('close', cleanup);
    stopActivity = activity.subscribe(send); if (closed) stopActivity();
    try { unsubscribe = await bridge.subscribe(id, send); if (closed) unsubscribe(); }
    catch (err) { send({ type: 'error', message: err.message }); cleanup(); }
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: '请求方法不支持' });
  const data = await body(req);
  if (action === 'fork') {
    if (typeof data.messageId !== 'string' || data.messageId.length>200) return json(res,400,{error:'请选择一条回复'});
    const lastTurnId = catalog.branchPoint(id,data.messageId);
    try {
      const result=await forks.create({sid:s.sid,requestId:data.requestId,threadId:id,lastTurnId});
      return json(res,200,{...result,title:(catalog.get(id).name || catalog.get(id).title || '会话').split('\n')[0]+' · 分支'});
    } catch(err) { return json(res,409,{error:err.message,unknown:!!err.unknown}); }
  }
  if (action === 'open-desktop') {
    if (!catalog.get(id)) return json(res, 404, { error: '会话不存在或已归档' });
    if (!ipc.clientId || !desktopOpener.enabled) return json(res, 409, { error: '请先在电脑启动 Codex；当前无法打开桌面会话' });
    return json(res, 200, await desktopOpener.openThread(id));
  }
  if (action === 'send') {
    if (data.mode !== undefined && !['message','steer'].includes(data.mode)) return json(res,400,{error:'无效发送方式'});
    if (typeof data.text !== 'string' || (!data.text.trim() && !data.uploadIds?.length) || data.text.length > 8000 || !/^[0-9a-f-]{36}$/.test(data.messageId || '')) return json(res, 400, { error: '请输入消息或选择附件，文字最多 8000 字' });
    const key = `${s.sid}:${id}:${data.messageId}`;
    if (!sends.has(key)) {
      if (sends.size >= 512) return json(res, 429, { error: '发送记录已满，请重启桥接程序' });
      const referenceIds = data.referenceIds || [], skillIds = data.skillIds || [];
      if (!Array.isArray(referenceIds) || !Array.isArray(skillIds) || referenceIds.length > 3 || skillIds.length > 5) return json(res, 400, { error: '最多引用 3 个会话、选择 5 个 Skill' });
      const references = [...new Set(referenceIds)].map(threadId => {
        if (threadId === id) throw new Error('不能引用当前会话自身');
        const row = catalog.get(threadId); if (!row) throw new Error('引用的会话不存在');
        return { hostId: 'local', threadId, title: row.name || row.title?.split('\n')[0] || '未命名会话' };
      });
      let skills = [];
      if (skillIds.length) {
        const row = catalog.get(id); if (!row) throw new Error('会话不存在');
        const available = await getSkills(row.cwd);
        skills = [...new Set(skillIds)].map(skillId => {
          const skill = available.skills.find(s => s.id === skillId); if (!skill) throw new Error('所选 Skill 已不可用，请重新选择'); return skill;
        });
      }
      const files = uploads.resolve(data.uploadIds || [],s.sid,id);
      uploads.retain(files);
      sends.set(key, bridge.send(id, data.text.trim() || '请查看附件。', data.messageId, { skills, references, uploads:files, mode:data.mode || 'message' }).then(result => { uploads.forget(files); return { result }; },
        err => ({ error: err.message, unknown: !!err.unknown || /连接已断开|request-timeout/.test(err.message) })));
    }
    const outcome = await sends.get(key);
    return json(res, outcome.error ? 409 : 200, outcome.error ? outcome : outcome.result);
  }
  if (action === 'stop') return json(res, 200, await bridge.stop(id));
  if (action === 'approval') return json(res, 200, await bridge.respond(id, data.requestId, data.decision));
  if (action === 'input') {
    try { return json(res, 200, await bridge.answer(id, data.requestId, data.answers)); }
    catch (err) { return json(res, 409, { error: err.message, unknown: !!err.unknown || /连接已断开|request-timeout/.test(err.message) }); }
  }
  if (action === 'settings') {
    const { models } = await getModels();
    const model = models.find(m => m.id === data.model);
    if (!model || !model.efforts.includes(data.effort)) return json(res, 400, { error: '请选择目录中的模型和支持的思考档位' });
    if(Object.hasOwn(data,'serviceTier')&&data.serviceTier!=='default'&&!model.serviceTiers?.some(t=>t.id===data.serviceTier))return json(res,400,{error:'当前模型目录未提供这个加速档位，请重新选择'});
    return json(res, 200, await bridge.settings(id, data));
  }
  return json(res, 404, { error: '接口不存在' });
}

const server = (tls ? https : http).createServer(tls || {}, (req, res) => {
  handler(req, res).catch(err => {
    if (!res.headersSent) json(res, 400, { error: err.message }); else res.end();
  });
});
server.requestTimeout = 35000;
server.headersTimeout = 15000;
async function listen() {
  const startPort = Number(process.env.REMOTE_CODING_PORT || 3210);
  for (port = startPort; port < startPort + 10; port++) {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); }); });
      return;
    } catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  throw new Error('没有可用监听端口');
}
let exiting = false;
function shutdown() {
  if (exiting) return; exiting = true;
  for (const stream of streams) stream.close();
  activity.close(); listStatus.close(); bridge.close(); catalog.close();
  const path = join(runtimeDir, 'runtime.json');
  try { if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path); } catch {}
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
await listen();
urls = lanIps.length ? lanIps.map(ip => `${protocol}://${ip}:${port}`) : [`${protocol}://127.0.0.1:${port}`];
writeRuntime();
ipc.connect();
console.log(`Remote Coding ready: ${protocol}://127.0.0.1:${port}; pairing is shown in the desktop control panel.`);
const housekeeping = setInterval(() => {
  for (const [sid, value] of sessions) if (value.expires < Date.now()) sessions.delete(sid);
  for (const [ip, value] of pairAttempts) if (value.until < Date.now()) pairAttempts.delete(ip);
  pairStore.prune();
}, 60000);
housekeeping.unref();
