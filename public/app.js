import { createReadTracker } from './read-state.js?v=25';
const $ = id => document.getElementById(id);
const effortNames = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
let csrf, currentId = null, source, writable = false, busy = false, sending = false, uncertain = false;
let historyCursor = null, threadNext = null, listQuery = '', listGeneration = 0, openGeneration = 0;
const drafts = new Map(), messageMap = new Map(), messageNodes = new Map();
const contexts = new Map(), inputDrafts = new Map(), inputStates = new Map();
const threadCompletion = new Map();
const threadStatuses = new Map(), liveStatusAt = new Map();
let statusRefreshing=false,lastListRead=0,statusScrollTimer,statusRefreshAgain=false;
let displayedCompletionKey = null;
let browserStorage;
try { browserStorage=localStorage; } catch { browserStorage={getItem:()=>null,setItem:()=>{}}; }
const readTracker=createReadTracker(browserStorage);
function markCurrentCompletionRead() {
  if (!currentId || !displayedCompletionKey || document.hidden || $('sidebar').classList.contains('open') || !isAtBottom()) return;
  readTracker.markRead(currentId,displayedCompletionKey);
  const actual=threadStatuses.get(currentId);
  paintThreadStatus(currentId,actual?.status || 'idle',displayedCompletionKey,actual?.completedAt,actual?.availability);
}
let selectedSkills = [], selectedThreads = [], pickerMode = 'skills', pickerItems = [], pickerNext = null, pickerGeneration = 0, requestSignature = '';
let requestsNow = [], imageReturnFocus;
let desktopOpenAvailable = false, openingDesktop = false, desktopOpenTimer;
let lastQuotaCheck = 0, quotaData;
let activeProvider = 'codex', providerInfo = [];
const providerNames = { codex: 'Codex', claude: 'Claude Code', workbuddy: 'WorkBuddy' };
if (!Object.hasOwn(providerNames, activeProvider)) activeProvider = 'codex';
function threadPath(id, action) { return activeProvider === 'codex' ? `/api/threads/${id}/${action}` : `/api/providers/${activeProvider}/threads/${id}/${action}`; }
let messageOrder = [], recentIds = new Set(), recentTurnIds = new Set(), toastTimer;
let currentModel = '', currentEffort = '', modelCatalog = [], settingsBaseline, hasUnread = false;
let expandFromId = null, olderOutsideRange = new Set();
const manualProgress = new Map();
const foldStorageKey = 'rc_progress_expansion_v1';
function loadExpansion(id) {
  try { return JSON.parse(localStorage.getItem(foldStorageKey) || '{}')[id] || null; } catch { return null; }
}
function saveExpansion() {
  try {
    const preferences = JSON.parse(localStorage.getItem(foldStorageKey) || '{}');
    delete preferences[currentId];
    if (expandFromId) preferences[currentId] = expandFromId;
    localStorage.setItem(foldStorageKey, JSON.stringify(Object.fromEntries(Object.entries(preferences).slice(-80))));
  } catch { /* Reading controls remain usable if browser storage is unavailable. */ }
}
function progressRange() {
  if (!expandFromId) return new Set();
  const index = messageOrder.indexOf(expandFromId);
  // On reopening, the latest page can be newer than the saved anchor. Older
  // pages stay outside the range until the anchor itself has been loaded.
  return new Set(index >= 0 ? messageOrder.slice(index + 1) : messageOrder.filter(id => !olderOutsideRange.has(id)));
}
function applyExpansion() {
  const range = progressRange();
  for (const id of messageOrder) {
    const node = messageNodes.get(id), details = node?.querySelector('.progress-details');
    if (details) details.open = manualProgress.has(id) ? manualProgress.get(id) : range.has(id);
    const button = node?.querySelector('.expand-following');
    if (button) {
      const active = id === expandFromId;
      button.textContent = active ? '⌃ 折叠后续' : '⌄ 展开后续';
      button.setAttribute('aria-pressed', String(active));
      button.title = active ? '收起这条消息之后的进度' : '展开这条消息之后的进度，包括新来的进度';
    }
  }
}
function toggleExpansion(id) {
  const scroll = $('message-scroll'), anchor = messageNodes.get(id);
  const offset = anchor.getBoundingClientRect().top;
  if (expandFromId === id) {
    for (const next of progressRange()) if (messageNodes.get(next)?.querySelector('.progress-details')) manualProgress.set(next, false);
    expandFromId = null;
  } else {
    expandFromId = id; olderOutsideRange.clear();
    for (const next of progressRange()) manualProgress.delete(next);
  }
  saveExpansion(); applyExpansion();
  scroll.scrollTop += anchor.getBoundingClientRect().top - offset;
  updateJump();
}
function orderMessageNodes() {
  const parent = $('messages'); let cursor = parent.firstElementChild;
  for (const id of messageOrder) {
    const node = messageNodes.get(id);
    if (node === cursor) cursor = cursor.nextElementSibling;
    else if (node) parent.insertBefore(node, cursor);
  }
  applyExpansion();
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options,
    headers: { ...(options.method ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/pair') showPair();
    const err = new Error(data.error || '请求失败'); err.unknown = data.unknown;err.status=response.status; throw err;
  }
  return data;
}
function post(path, data) { return api(path, { method: 'POST', body: JSON.stringify(data) }); }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
function banner(text) { $('banner').textContent = text || ''; $('banner').hidden = !text; }
function showPair() {
  disconnect(); $('pair-view').hidden = false; $('workspace').hidden = true;
  csrf = null; writable = false; currentId = null; messageMap.clear(); messageNodes.clear(); messageOrder = [];
  $('messages').replaceChildren(); $('draft').value = ''; drafts.clear();
  contexts.clear(); inputDrafts.clear(); inputStates.clear(); selectedSkills = []; selectedThreads = []; renderContext();
  quotaData = null; lastQuotaCheck = 0; $('quota-windows').textContent = '连接后读取额度'; $('quota-updated').textContent = '当前电脑登录的 Codex 账号';
  $('picker-overlay').hidden = true; closeImage();
}
function setSidebar(open) {
  $('sidebar').classList.toggle('open', open); $('scrim').hidden = !open;
  if (open && csrf) { loadThreads(); loadQuota(); }
  if (!open) requestAnimationFrame(markCurrentCompletionRead);
}
function quotaWindowName(window) {
  const minutes = window.minutes;
  if (minutes === 10080) return '每周额度';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return minutes ? `${minutes} 分钟额度` : window.kind === 'primary' ? '主额度' : '次额度';
}
function renderQuota(data) {
  const container = $('quota-windows'); container.replaceChildren();
  for (const bucket of data.buckets || []) for (const window of bucket.windows || []) {
    const row = document.createElement('div'); row.className = 'quota-window' + (window.remaining !== null && window.remaining < 20 ? ' low' : '');
    const title = document.createElement('div'); title.className = 'quota-window-title';
    const label = document.createElement('span'); label.textContent = (data.buckets.length > 1 ? bucket.name + ' · ' : '') + quotaWindowName(window);
    const remaining = document.createElement('strong'); remaining.textContent = window.remaining === null ? '未提供' : `${data.stale ? '上次剩余' : '剩余'} ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(window.remaining)}%`;
    title.append(label, remaining); row.append(title);
    if (window.remaining !== null) {
      const meter = document.createElement('meter'); meter.min = 0; meter.max = 100; meter.value = window.remaining;
      meter.setAttribute('aria-label', label.textContent + '剩余额度'); row.append(meter);
    }
    const reset = document.createElement('small'); reset.textContent = window.resetsAt ? '重置 ' + new Date(window.resetsAt).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '重置时间未提供';
    row.append(reset); container.append(row);
  }
  if (!container.childElementCount) { const note = document.createElement('small'); note.textContent = '此账号暂未提供额度数据'; container.append(note); }
  const plan = data.buckets?.find(b => b.plan)?.plan;
  $('quota-plan').textContent = plan ? plan.toUpperCase() : '';
  $('quota-updated').textContent = (data.stale ? '更新失败 · 上次读取 ' : '更新 ') + new Date(data.updatedAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
  $('refresh-quota').title = '刷新账号额度 · ' + $('quota-updated').textContent;
}
async function loadQuota(force = false) {
  if (!csrf || $('refresh-quota').disabled || (!force && Date.now() - lastQuotaCheck < 60000)) return;
  lastQuotaCheck = Date.now(); $('refresh-quota').disabled = true;
  try { quotaData = await api('/api/quota'); renderQuota(quotaData); }
  catch {
    if (quotaData) renderQuota({ ...quotaData, stale: true });
    else { $('quota-windows').textContent = '额度暂时无法读取'; $('quota-updated').textContent = '可点右上角刷新重试'; }
  } finally { $('refresh-quota').disabled = false; }
}
function setConnection(text, connected, desktopConnected = connected) {
  $('connection-label').textContent = text;
  $('connection-dot').className = 'dot' + (connected ? '' : ' warn');
  $('device-status').textContent = providerNames[activeProvider] + (desktopConnected ? ' 已连接' : ' 暂未连接');
  $('device-dot').className = 'dot' + (desktopConnected ? '' : ' warn');
}
function updateComposer() {
  $('draft').disabled = !currentId;
  $('send').disabled = !writable || (busy && activeProvider !== 'codex') || sending || uncertain || !$('draft').value.trim();
  const steering = busy && activeProvider === 'codex';
  $('send').textContent = steering ? '引导' : '↑'; $('send').classList.toggle('steer',steering);
  $('send').setAttribute('aria-label',steering ? '发送引导消息' : '发送消息');
  $('send').title = steering ? '把这句话追加到当前任务，不停止执行' : '发送消息';
  $('stop').hidden = !writable || !busy; $('activity').hidden = !busy || requestsNow.length>0;
  $('draft-note').textContent = uncertain ? '发送结果待确认，请先核对桌面消息，不要重复发送' : writable&&requestsNow.length ? '待操作 · 请处理会话里的问题或审批' : busy ? '正在执行 · 可随时补充一句引导' : writable ? '消息会交给当前桌面会话执行' : '查看历史 · 在电脑打开此会话后可发送';
  $('char-count').textContent = $('draft').value.length > 5000 ? `${$('draft').value.length}/8000` : '';
  $('model-settings').disabled = !writable || activeProvider !== 'codex';
  $('pick-thread').disabled = !currentId || sending || activeProvider !== 'codex';
  $('pick-skill').disabled = !currentId || sending || activeProvider !== 'codex';
  document.querySelector('.context-actions').hidden = activeProvider !== 'codex';
  $('model-settings').title = activeProvider === 'codex' ? '选择模型与思考档位' : '模型设置请在电脑端处理';
  $('draft').placeholder = `发消息给电脑上的 ${providerNames[activeProvider]}…`;
  if (activeProvider !== 'codex') $('draft-note').textContent = uncertain ? '结果待确认，请核对电脑，避免重复发送' : writable ? activeProvider === 'claude' ? '通过本机通道发送 · 审批仍在电脑处理' : '发送到 WorkBuddy 本地助理' : '查看历史 · 等待电脑连接';
}
function offline(text, connected = false, reason = '') {
  if (!text) clearTimeout(desktopOpenTimer);
  $('offline-panel').hidden = !text;
  $('offline-title').textContent = !connected ? providerNames[activeProvider] + ' 暂未连接' : reason === 'syncing'
    ? '正在同步这条会话' : reason === 'connection-error' ? '桌面会话连接失败' : '当前会话尚未在电脑加载';
  $('offline-description').textContent = text || '';
  $('open-desktop').hidden = !text || !connected || !desktopOpenAvailable || reason === 'syncing' || reason === 'connection-error';
  $('open-desktop').disabled = openingDesktop;
  if (text) { busy = false; $('requests').querySelectorAll('button,input,textarea').forEach(el => { el.disabled = true; }); }
}
function timeLabel(message) {
  if (!message.at || !Number.isFinite(Number(message.at))) return null;
  const date = new Date(Number(message.at)), today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return { short: (message.timeSource === 'turn' ? '本轮 ' : '') + date.toLocaleString('zh-CN', { ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false }),
    full: date.toLocaleString('zh-CN', { hour12: false }) + (message.timeSource === 'turn' ? '（本轮开始时间）' : '') };
}
function addTime(parent, message) {
  const value = timeLabel(message); if (!value) return;
  const time = document.createElement('time'); time.className = 'message-time'; time.textContent = value.short; time.title = value.full;
  time.dateTime = new Date(Number(message.at)).toISOString(); parent.append(time);
}
function imageGallery(body, message) {
  if (!message.images?.length) return;
  const gallery = document.createElement('div'); gallery.className = 'image-gallery';
  for (const picture of message.images) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'image-thumb'; button.setAttribute('aria-label', '放大图片：' + picture.name);
    const img = document.createElement('img'); img.src = picture.url; img.alt = picture.name; img.loading = 'lazy'; img.decoding = 'async';
    const caption = document.createElement('span'); caption.textContent = '点击放大';
    img.onerror = () => { img.hidden = true; caption.textContent = '图片无法读取 · 点击重试'; };
    button.onclick = () => {
      imageReturnFocus = button; $('image-overlay').classList.remove('original-size'); $('image-size').textContent = '查看原图尺寸';
      $('full-image').src = picture.url; $('full-image').alt = picture.name; $('image-caption').textContent = picture.name.startsWith('codex-clipboard-') ? '图片预览' : picture.name;
      $('image-overlay').hidden = false; $('close-image').focus();
    };
    button.append(img, caption); gallery.append(button);
  }
  body.append(gallery);
}
function closeImage() { $('image-overlay').hidden = true; $('full-image').removeAttribute('src'); imageReturnFocus?.focus(); imageReturnFocus = null; }
function isAtBottom() { const s = $('message-scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 100; }
function updateJump() {
  const s = $('message-scroll');
  const away = s.scrollHeight - s.scrollTop - s.clientHeight > 140;
  $('jump-bottom').hidden = !away || !messageOrder.length;
  if (!away) hasUnread = false;
  $('new-message-label').hidden = !hasUnread;
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const selected = document.activeElement;
  const input = document.createElement('textarea'); input.value = text;
  input.style.position = 'fixed'; input.style.left = '-9999px'; document.body.append(input);
  input.focus(); input.select(); input.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy'); input.remove(); selected?.focus();
  if (!copied) throw new Error('无法复制，请长按选择文本');
}
function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const s = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(at, match.index)));
    const token = match[0]; let node;
    if (token.startsWith('`')) { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
    else if (token.startsWith('**')) { node = document.createElement('strong'); node.textContent = token.slice(2, -2); }
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (/^https?:\/\//i.test(parts[2])) { node = document.createElement('a'); node.href = parts[2]; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.textContent = parts[1]; }
      else { node = document.createElement('span'); node.textContent = parts[1]; }
    }
    parent.append(node); at = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(at)));
}
function markdown(text) {
  const frag = document.createDocumentFragment(), lines = text.split('\n');
  let paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { const p = document.createElement('p'); inline(p, paragraph.join('\n')); frag.append(p); paragraph = []; } list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); const language = line.trim().slice(3); const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const block = document.createElement('div'); block.className = 'code-block';
      const heading = document.createElement('div'); heading.className = 'code-heading';
      const label = document.createElement('span'); label.textContent = language || 'CODE';
      const button = document.createElement('button'); button.textContent = '复制';
      button.onclick = async () => { try { await copyText(code.join('\n')); button.textContent = '已复制'; } catch { toast('无法复制，请长按选择文本'); } };
      const pre = document.createElement('pre'), el = document.createElement('code'); el.textContent = code.join('\n');
      heading.append(label, button); pre.append(el); block.append(heading, pre); frag.append(block); continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3}/.test(lines[i+1] || '')) {
      flush(); const wrap = document.createElement('div'); wrap.className = 'table-wrap'; const table = document.createElement('table');
      const row = (text, tag) => { const tr = document.createElement('tr'); for (const c of text.replace(/^\s*\||\|\s*$/g, '').split('|')) { const td = document.createElement(tag); inline(td, c.trim()); tr.append(td); } table.append(tr); };
      row(line, 'th'); i++;
      while (i+1 < lines.length && /^\s*\|/.test(lines[i+1])) row(lines[++i], 'td');
      wrap.append(table); frag.append(wrap); continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { flush(); const h = document.createElement(`h${heading[1].length}`); inline(h, heading[2]); frag.append(h); continue; }
    const bullet = /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) { if (paragraph.length) flush(); const type = bullet[1] ? 'UL' : 'OL'; if (!list || list.tagName !== type) { list = document.createElement(type.toLowerCase()); frag.append(list); } const li = document.createElement('li'); inline(li, bullet[2]); list.append(li); continue; }
    if (/^>\s?/.test(line)) { flush(); const quote = document.createElement('blockquote'); inline(quote, line.replace(/^>\s?/, '')); frag.append(quote); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) list = null;
    paragraph.push(line);
  }
  flush(); return frag;
}
function renderMessage(message) {
  const el = document.createElement('article'); el.className = `message ${message.role}${message.phase === 'commentary' ? ' progress' : ''}${message.kind === 'question' ? ' question-message' : ''}${message.guidance ? ' guidance-message' : ''}`; el.dataset.id = message.id;
  if (message.role === 'assistant' && message.phase !== 'commentary') {
    const label = document.createElement('div'); label.className = 'message-label';
    label.textContent = message.kind === 'question' ? (message.questionAnswered ? '◎  Codex · 已回应的操作询问' : '◎  Codex · 历史询问（已结束）') : '◎  ' + providerNames[activeProvider]; el.append(label);
    addTime(label, message);
  }
  const body = document.createElement('div'); body.className = 'message-body';
  if(message.guidance){const badge=document.createElement('span');badge.className='guidance-badge';badge.textContent='↳ 引导';body.append(badge);}
  imageGallery(body, message);
  if (message.role === 'user') {
    if (message.references?.length || message.skills?.length) {
      const context = document.createElement('div'); context.className = 'message-context';
      for (const reference of message.references || []) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '↗ ' + reference.title;
        button.onclick = () => openThread(reference.id, reference.title); context.append(button);
      }
      for (const name of message.skills || []) { const tag = document.createElement('span'); tag.textContent = '✦ ' + name; context.append(tag); }
      body.append(context);
    }
    if (message.attachments?.length) {
      const files = document.createElement('div'); files.className = 'attachment-chips';
      const images = message.attachments.filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name)).length;
      const other = message.attachments.length - images;
      files.textContent = [images ? `▧ ${images} 张图片` : '', other ? `▤ ${other} 个附件` : ''].filter(Boolean).join(' · ');
      body.append(files);
    }
    // Compatibility with stored messages from an older bridge during a live upgrade.
    let text = message.text;
    if (/^(?:# Files mentioned by the user:|# Response annotations:|<response-annotations>|<in-app-browser-context\b|<external_codex_apps_open_page>)/.test(text.trimStart()) && text.includes('## My request:')) {
      text = text.slice(text.lastIndexOf('## My request:') + '## My request:'.length).trim();
    }
    body.append(document.createTextNode(text));
  } else {
    const text = message.text.replace(/:codex-annotation\{index="\d+"\}/g, '');
    body.append(markdown(message.images?.length ? text.replace(/!\[[^\]]*\]\(<?(?:[A-Za-z]:[\\/]|\/)[^\n]*?\.(?:png|jpe?g|gif|webp)>?\)/gi, '') : text));
  }
  if (message.phase === 'commentary') {
    const details = document.createElement('details'); details.className = 'progress-details';
    const summary = document.createElement('summary');
    const label = document.createElement('span'); label.className = 'progress-tag'; label.textContent = '进度';
    const preview = document.createElement('span'); preview.className = 'progress-preview'; preview.textContent = message.text.replace(/\*\*|`/g, '').slice(0, 70);
    summary.append(label, preview); addTime(summary, message); details.append(summary, body); el.append(details);
    summary.onclick = event => {
      event.preventDefault();
      manualProgress.set(message.id, !details.open); details.open = !details.open;
      updateJump();
    };
  } else {
    el.append(body);
    if (message.role === 'user') {
      const actions = document.createElement('div'); actions.className = 'user-message-actions';
      addTime(actions, message);
      const expand = document.createElement('button'); expand.className = 'expand-following'; expand.type = 'button';
      expand.onclick = () => toggleExpansion(message.id);
      actions.append(expand); el.append(actions);
    }
    if (message.role === 'assistant') {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      const copy = document.createElement('button'); copy.textContent = '复制'; copy.setAttribute('aria-label', '复制这条回复');
      copy.onclick = async () => { try { await copyText(message.text); toast('已复制回复'); } catch (err) { toast(err.message); } };
      actions.append(copy); el.append(actions);
      if (message.kind === 'question' && !message.questionAnswered) {
        const answer = document.createElement('button'); answer.type = 'button'; answer.className = 'answer-question';
        answer.textContent = '前往回答'; answer.hidden = true;
        answer.onclick = () => {
          const card = el.querySelector('.question-controls') || [...$('requests').children].find(el => el.dataset.request === 'async:' + message.id);
          if (!card) { toast('这条问题已结束或暂未同步，请查看最新消息'); return; }
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card.querySelector('input:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus({ preventScroll: true });
        };
        actions.append(answer);
        const controls = document.createElement('div'); controls.className = 'question-controls'; el.append(controls);
      }
    }
  }
  return el;
}
function mergeMessages(incoming, { prepend = false, remove = [] } = {}) {
  const scroll = $('message-scroll'), height = scroll.scrollHeight, top = scroll.scrollTop;
  const nearBottom = height - top - scroll.clientHeight < 100;
  for (const id of remove) { messageMap.delete(id); messageNodes.get(id)?.remove(); messageNodes.delete(id); }
  messageOrder = messageOrder.filter(id => !remove.includes(id));
  const additions = [];
  for (const m of incoming) {
    if (!m.id || (!m.text && !m.images?.length)) continue;
    const old = messageMap.get(m.id);
    if (!old) additions.push(m.id);
    if (!old && prepend && expandFromId && !messageOrder.includes(expandFromId)) olderOutsideRange.add(m.id);
    if (old && JSON.stringify(old) === JSON.stringify(m)) continue;
    messageMap.set(m.id, m);
    const el = renderMessage(m), existing = messageNodes.get(m.id);
    if (existing) {
      existing.replaceWith(el);
    }
    messageNodes.set(m.id, el);
  }
  messageOrder = prepend ? [...additions, ...messageOrder] : [...messageOrder, ...additions];
  messageOrder = [...new Set(messageOrder)];
  // A finite phone DOM prevents extremely long histories from exhausting memory.
  if (messageOrder.length > 300) {
    const discarded = prepend ? messageOrder.splice(300) : messageOrder.splice(0, messageOrder.length - 300);
    for (const id of discarded) { messageNodes.get(id)?.remove(); messageNodes.delete(id); messageMap.delete(id); }
    if (prepend) disconnect();
    toast('已保留当前 300 条消息，点重新连接可返回最新内容');
  }
  orderMessageNodes();
  if (incoming.some(m => m.kind === 'question')) renderRequests(requestsNow);
  $('empty').hidden = messageOrder.length > 0;
  if (prepend) scroll.scrollTop = top + scroll.scrollHeight - height;
  else if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  updateJump();
}
function syncLiveOrder(order) {
  const liveIds = new Set(order);
  messageOrder = [...messageOrder.filter(id => !liveIds.has(id)), ...order.filter(id => messageNodes.has(id))];
  orderMessageNodes();
}
function renderRequests(requests) {
  requestsNow = requests || [];
  const inlineIds = [];
  const uiSignature = JSON.stringify([currentId, writable, requestsNow, [...inputStates]]);
  for (const [id, node] of messageNodes) {
    const action = node.querySelector('.answer-question');
    if (action) {
      const request = requestsNow.find(r => r.id === 'async:' + id), active = !!request;
      action.hidden = !active; action.disabled = !writable;
      const label = node.querySelector('.message-label');
      if (label?.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.nodeValue = active
        ? request.historical ? '◎  Codex · 历史问题，可补充回答' : '◎  Codex · 需要你处理' : '◎  Codex · 历史询问（已结束）';
      action.textContent = request?.historical ? '回复这道问题' : '前往回答';
      const controls = node.querySelector('.question-controls');
      if (controls && active) {
        inlineIds.push(request.id);
        if (controls.dataset.signature !== uiSignature) { controls.replaceChildren(questionForm(request)); controls.dataset.signature = uiSignature; }
      } else if (controls) { controls.replaceChildren(); delete controls.dataset.signature; }
    }
  }
  const activeKeys = new Set(requestsNow.map(r => currentId + ':' + r.id));
  for (const key of inputDrafts.keys()) if (key.startsWith(currentId + ':') && !activeKeys.has(key)) inputDrafts.delete(key);
  const signature = JSON.stringify([uiSignature, inlineIds]);
  if (signature === requestSignature) return;
  requestSignature = signature;
  $('requests').replaceChildren();
  for (const req of requests || []) {
    if (inlineIds.includes(req.id)) continue;
    const card = document.createElement('div'); card.className = 'request-card';
    const title = document.createElement('strong'); title.textContent = 'Codex 等待你的处理';
    card.dataset.request = req.id;
    if (['item/tool/requestUserInput', 'remote-coding/asyncUserInput'].includes(req.method)) {
      card.append(title); card.append(questionForm(req)); $('requests').append(card); continue;
    }
    const p = document.createElement('p'); p.textContent = req.command || req.reason || (req.questions || []).map(q => q.question).join('\n') || '请查看电脑端的审批详情。';
    card.append(title, p);
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(req.method)) {
      for (const [decision, label] of [['accept', '允许这次操作'], ['decline', '拒绝']]) {
        const button = document.createElement('button'); button.textContent = label; if (decision === 'accept') button.className = 'accept';
        button.disabled = !writable;
        button.onclick = async () => {
          const id = currentId;
          if (decision === 'accept' && !confirm(`允许当前 Codex 审批操作？\n\n${p.textContent}`)) return;
          button.disabled = true;
          try { await post(`/api/threads/${id}/approval`, { requestId: req.id, decision }); toast('已提交审批决定'); }
          catch (err) { toast(err.message); button.disabled = false; }
        };
        card.append(button);
      }
    } else { const note = document.createElement('small'); note.textContent = '此类请求请在电脑端处理'; card.append(note); }
    $('requests').append(card);
  }
}
function questionForm(req) {
  const key = currentId + ':' + req.id, id = currentId;
  if (!inputDrafts.has(key)) inputDrafts.set(key, {});
  const saved = inputDrafts.get(key), form = document.createElement('form'); form.className = 'question-form';
  for (const q of req.questions || []) {
    const field = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = q.question; field.append(legend);
    const name = uuid(), choices = q.options || [];
    const input = document.createElement(q.isSecret ? 'input' : 'textarea'); input.className = 'question-text';
    if (q.isSecret) { input.type = 'password'; input.autocomplete = 'off'; }
    else { input.rows = 2; input.maxLength = 4000; }
    input.setAttribute('aria-label', choices.length ? '其他答案：' + q.question : q.question);
    input.value = choices.some(o => o.label === saved[q.id]) ? '' : saved[q.id] || '';
    input.oninput = () => { saved[q.id] = input.value; };
    input.hidden = choices.length > 0 && (!saved[q.id] || choices.some(o => o.label === saved[q.id]));
    for (const option of [...choices, ...(choices.length && q.isOther ? [{ label: '填写其他答案', other: true }] : [])]) {
      const label = document.createElement('label'); label.className = 'question-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = name;
      radio.checked = option.other ? !!input.value : saved[q.id] === option.label;
      const text = document.createElement('span'), strong = document.createElement('strong'); strong.textContent = option.label; text.append(strong);
      if (option.description) { const small = document.createElement('small'); small.textContent = option.description; text.append(small); }
      radio.onchange = () => { input.hidden = !option.other; saved[q.id] = option.other ? input.value : option.label; if (option.other) input.focus(); };
      label.append(radio, text); field.append(label);
    }
    if (!choices.length || q.isOther) field.append(input);
    form.append(field);
  }
  const note = document.createElement('p'); note.className = 'input-status';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'accept';
  submit.textContent = req.historical ? '将答案发送到当前会话' : '提交答案给电脑';
  const state = inputStates.get(key);
  note.textContent = state === 'accepted' ? '已提交，等待电脑同步处理结果' : state === 'unknown' ? '结果待确认，请先核对电脑，避免重复提交' : state === 'sending' ? '正在提交…' : req.historical
    ? '原问题所在的一轮已结束。你提交后，原问题和答案会一起发送到当前会话。' : '答案只提交给这条会话的当前问题';
  form.append(submit, note);
  form.querySelectorAll('button,input,textarea').forEach(el => { el.disabled = !writable || !!state; });
  form.onsubmit = async event => {
    event.preventDefault(); if (!writable || inputStates.has(key) || currentId !== id) return;
    if ((req.questions || []).some(q => !saved[q.id]?.trim())) { note.textContent = '请回答所有问题'; return; }
    inputStates.set(key, 'sending'); renderRequests(requestsNow);
    try { await post(`/api/threads/${id}/input`, { requestId: req.id, answers: saved }); inputStates.set(key, 'accepted'); }
    catch (err) { if (err.unknown || err instanceof TypeError) inputStates.set(key, 'unknown'); else inputStates.delete(key); toast(err.message); }
    finally { if (currentId === id) renderRequests(requestsNow); }
  };
  return form;
}

function saveContext() { if (currentId) contexts.set(currentId, { skills: [...selectedSkills], threads: [...selectedThreads] }); }
function renderContext() {
  const container = $('selected-context'); container.replaceChildren();
  for (const [type, items] of [['skill', selectedSkills], ['thread', selectedThreads]]) for (const item of items) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'context-chip';
    const name = item.displayName || item.name || item.title;
    chip.textContent = `${type === 'skill' ? '✦' : '↗'} ${name} ×`; chip.title = '移除' + name;
    chip.onclick = () => { if (type === 'skill') selectedSkills = selectedSkills.filter(s => s.id !== item.id); else selectedThreads = selectedThreads.filter(s => s.id !== item.id); saveContext(); renderContext(); renderPicker(); };
    container.append(chip);
  }
  container.hidden = !container.childElementCount;
}
function renderPicker() {
  const selected = pickerMode === 'skills' ? selectedSkills : selectedThreads;
  const query = $('picker-search').value.trim().toLowerCase(); $('picker-results').replaceChildren();
  const visible = pickerItems.filter(item => item.id !== currentId && (pickerMode !== 'skills' || `${item.displayName} ${item.name} ${item.description}`.toLowerCase().includes(query)));
  for (const item of visible) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-item';
    button.setAttribute('aria-pressed', String(selected.some(s => s.id === item.id)));
    const name = document.createElement('strong'); name.textContent = item.displayName || item.title || item.name;
    const detail = document.createElement('small'); detail.textContent = item.description || item.project || '';
    const tick = document.createElement('span'); tick.className = 'picker-tick'; tick.textContent = selected.some(s => s.id === item.id) ? '✓' : '＋';
    button.append(name, detail, tick); button.onclick = () => {
      const exists = selected.some(s => s.id === item.id);
      if (!exists && selected.length >= (pickerMode === 'skills' ? 5 : 3)) { $('picker-error').textContent = pickerMode === 'skills' ? '每条消息最多选择 5 个 Skill' : '每条消息最多引用 3 个会话'; return; }
      if (pickerMode === 'skills') selectedSkills = exists ? selected.filter(s => s.id !== item.id) : [...selected, item];
      else selectedThreads = exists ? selected.filter(s => s.id !== item.id) : [...selected, item];
      saveContext(); renderContext(); renderPicker();
    };
    $('picker-results').append(button);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'picker-empty'; empty.textContent = query ? '没有匹配项，试试其他关键词' : '当前没有可选择的项目'; $('picker-results').append(empty); }
  $('picker-done').textContent = `完成选择（${selected.length}）`;
}
async function loadPicker(append = false) {
  const generation = ++pickerGeneration, id = currentId;
  $('picker-error').textContent = ''; $('picker-more').disabled = true;
  try {
    const data = pickerMode === 'skills' ? await api(`/api/threads/${id}/skills`) : await api(`/api/threads?q=${encodeURIComponent($('picker-search').value.trim())}&offset=${append ? pickerNext || 0 : 0}`);
    if (generation !== pickerGeneration || currentId !== id || $('picker-overlay').hidden) return;
    const items = pickerMode === 'skills' ? data.skills : data.threads;
    pickerItems = append ? [...pickerItems, ...items] : items; pickerNext = data.next;
    $('picker-more').hidden = pickerMode !== 'threads' || pickerNext == null;
    if (data.warnings) $('picker-error').textContent = `有 ${data.warnings} 项技能配置未能读取，列表只显示可用项`;
    renderPicker();
  } catch (err) { if (generation === pickerGeneration) { $('picker-results').replaceChildren(); $('picker-error').textContent = err.message; } }
  finally { $('picker-more').disabled = false; }
}
function openPicker(mode) {
  pickerMode = mode; pickerItems = []; pickerNext = null;
  $('picker-title').textContent = mode === 'skills' ? '选择 Skill' : '引用会话';
  $('picker-intro').textContent = mode === 'skills' ? '选择当前会话可用的技能，随下一条消息发送。' : '搜索并引用其他会话，为当前任务补充上下文。消息仍发送到当前会话。';
  $('picker-search').value = ''; $('picker-overlay').hidden = false; $('picker-results').textContent = '正在读取…'; $('picker-more').hidden = true;
  $('picker-search').focus(); loadPicker();
}
function closePicker() { ++pickerGeneration; $('picker-overlay').hidden = true; (pickerMode === 'skills' ? $('pick-skill') : $('pick-thread')).focus(); }

async function loadThreads(append = false) {
  const generation = ++listGeneration;
  const started=Date.now();
  const listScrollTop = $('threads').scrollTop;
  $('refresh-list').disabled = true;
  try {
    const data = await api(`${activeProvider === 'codex' ? '/api/threads' : '/api/providers/' + activeProvider + '/threads'}?offset=${append ? threadNext || 0 : 0}&q=${encodeURIComponent(listQuery)}`);
    if (generation !== listGeneration) return;
    lastListRead=Date.now();
    if (!append) $('threads').replaceChildren();
    for (const thread of data.threads) {
      const button = document.createElement('button'); button.className = 'thread-row' + (thread.id === currentId ? ' selected' : ''); button.dataset.id = thread.id;
      const title = document.createElement('strong'); title.textContent = thread.title;
      const meta = document.createElement('small'), project = document.createElement('span'), time = document.createElement('time');
      const date = new Date(thread.updatedAt), today = date.toDateString() === new Date().toDateString();
      project.textContent = thread.project;
      time.textContent = date.toLocaleString('zh-CN', today ? {hour:'2-digit',minute:'2-digit',hour12:false} : {month:'numeric',day:'numeric'});
      time.title = '最近活动：' + date.toLocaleString('zh-CN', {hour12:false});
      const heading=document.createElement('div');heading.className='thread-row-heading';heading.append(title);
      meta.append(project, time); button.append(heading, meta); button.onclick = () => openThread(thread.id, thread.title); $('threads').append(button);
      const recent=liveStatusAt.get(thread.id)>=started ? threadStatuses.get(thread.id) : thread;
      paintThreadStatus(thread.id,recent.status,recent.completionKey,recent.completedAt,recent.availability);
    }
    threadNext = data.next; $('more-threads').hidden = threadNext === null;
    $('threads').scrollTop = listScrollTop;
    if (!currentId && data.threads.length) {
      const saved = sessionStorage.getItem('rc_thread_' + activeProvider) || (activeProvider === 'codex' ? sessionStorage.getItem('rc_thread') : null);
      const first = data.threads.find(t => t.id === saved) || data.threads[0]; await openThread(first.id, first.title);
    }
    $('integration-panel').hidden = !!currentId || activeProvider === 'codex';
    if (!currentId && activeProvider !== 'codex') renderIntegration();
    requestAnimationFrame(()=>refreshThreadStatuses());
  } catch (err) { toast(err.message); if (activeProvider !== 'codex') renderIntegration(err.message); }
  finally { if (generation === listGeneration) $('refresh-list').disabled = false; }
}
function paintThreadStatus(id,status,completionKey,completedAt,availability) {
  availability=availability ?? threadStatuses.get(id)?.availability ?? 'unknown';
  threadStatuses.set(id,{status,completionKey,completedAt,availability});
  if(threadStatuses.size>500)threadStatuses.delete(threadStatuses.keys().next().value);
  if(completionKey!==undefined) threadCompletion.set(id,completionKey);
  const unread=readTracker.observe(id,{status,completionKey:threadCompletion.get(id),completedAt});
  if(unread)status='unread';
  const row=[...$('threads').children].find(el=>el.dataset.id===id);if(!row)return;
  let loadBadge=row.querySelector('.thread-availability');
  if(availability==='notLoaded') {
    if(!loadBadge){loadBadge=document.createElement('span');loadBadge.className='thread-availability';row.querySelector('small').insertBefore(loadBadge,row.querySelector('time'));}
    loadBadge.textContent='未加载';loadBadge.title='尚未在电脑 Codex 加载，历史仍可查看；发送前需要先在电脑打开';
  } else loadBadge?.remove();
  const names={running:['●','进行中'],waiting:['◐','待操作'],unread:['●','已完成'],error:['!','出错'],stopped:['■','已停止'],offline:['○','离线'],notLoaded:['○','未加载']};
  let icon=row.querySelector('.thread-status');
  if(!names[status]){icon?.remove();return;}
  if(!icon){icon=document.createElement('span');row.querySelector('.thread-row-heading').append(icon);}
  icon.className='thread-status '+status;icon.title=status==='unread'?'已完成，手机尚未查看':names[status][1];icon.setAttribute('aria-label',icon.title);
  icon.textContent=names[status][0]+(['running','waiting','unread','stopped'].includes(status)?' '+names[status][1]:'');
}
function listIsVisible(){return !$('workspace').hidden&&!document.hidden&&($('sidebar').classList.contains('open')||window.matchMedia('(min-width: 721px)').matches);}
function visibleThreadIds() {
  const bounds=$('threads').getBoundingClientRect();
  return [...$('threads').children].filter(el=>{const r=el.getBoundingClientRect();return r.bottom>bounds.top&&r.top<bounds.bottom;}).map(el=>el.dataset.id).filter(Boolean).slice(0,24);
}
async function refreshThreadStatuses() {
  if(!csrf||activeProvider!=='codex'||!listIsVisible())return;
  if(statusRefreshing){statusRefreshAgain=true;return;}
  const ids=visibleThreadIds();
  if(!ids.length)return;
  statusRefreshing=true;const started=Date.now(),generation=listGeneration;
  try {
    let data;
    try{data=await post('/api/thread-statuses',{ids});}
    catch(err){
      if(err.status!==403)throw err;
      const session=await api('/api/status');csrf=session.csrf;
      data=await post('/api/thread-statuses',{ids});
    }
    if(activeProvider!=='codex'||generation!==listGeneration||!listIsVisible())return;
    for(const thread of data.threads)if(!(liveStatusAt.get(thread.id)>=started))paintThreadStatus(thread.id,thread.status,thread.completionKey,thread.completedAt,thread.availability);
  } catch { /* The chat connection owns offline notices; keep the last list on a transient failure. */ }
  finally {statusRefreshing=false;if(statusRefreshAgain){statusRefreshAgain=false;requestAnimationFrame(()=>refreshThreadStatuses());}}
}
function disconnect() { source?.close(); source = null; }
function connectEvents(id, generation) {
  disconnect();
  if (document.hidden || !csrf) return;
  source = new EventSource(threadPath(id, 'events'));
  source.onopen = () => {
    if (generation !== openGeneration) return;
    api(threadPath(id, 'history')).then(page => {
      if (generation === openGeneration) mergeMessages(page.messages.filter(m => !recentTurnIds.has(m.turnId)), { prepend: true });
    }).catch(() => {});
  };
  source.onmessage = event => {
    if (generation !== openGeneration) return;
    const data = JSON.parse(event.data);
    if(data.type==='list-status') {
      if(activeProvider==='codex'&&listIsVisible())for(const row of data.threads || []) {
        liveStatusAt.set(row.id,Date.now());if(liveStatusAt.size>500)liveStatusAt.delete(liveStatusAt.keys().next().value);
        paintThreadStatus(row.id,row.status,row.completionKey,row.completedAt,row.availability);
      }
      return;
    }
    if (data.type === 'connection') {
      writable = !!data.writable;
      if(activeProvider==='codex') {
        const actual=threadStatuses.get(id);
        const availability=data.writable?'ready':!data.connected?'offline':data.reason==='owner-unavailable'?'notLoaded':'unknown';
        liveStatusAt.set(id,Date.now());
        if(liveStatusAt.size>500)liveStatusAt.delete(liveStatusAt.keys().next().value);
        paintThreadStatus(id,actual?.status || 'unknown',actual?.completionKey,actual?.completedAt,availability);
      }
      offline(data.writable ? '' : data.message, data.connected, data.reason); setConnection(data.message, data.writable, data.connected); renderRequests(requestsNow); updateComposer(); return;
    }
    if (data.type === 'snapshot' || data.type === 'update') {
      const followBottom = isAtBottom();
      writable = data.writable; busy = data.busy;
      offline(writable ? '' : `${providerNames[activeProvider]} 电脑端离线，历史仍可查看`);
      if (data.title) $('thread-title').textContent = data.title;
      currentModel = data.model || ''; currentEffort = data.effort || '';
      $('model-label').textContent = [data.model, data.effort ? effortNames[data.effort] || data.effort : activeProvider === 'codex' ? '桌面默认' : ''].filter(Boolean).join(' · ');
      const status=data.status || ((data.requests || []).length?'waiting':busy?'running':'idle');
      setConnection(!writable ? '电脑端离线 · 仅查看历史' : status==='waiting' ? '待操作 · 电脑正在等你处理' : busy ? '桌面正在执行 · 实时同步' : '已连接电脑 · 可发送消息', writable);
      if (!uncertain) banner('');
      recentTurnIds = new Set(data.turnIds || []);
      if (data.type === 'snapshot') {
        recentIds = new Set(data.messages.map(m => m.id));
        const stale = [...messageMap.values()].filter(m => recentTurnIds.has(m.turnId) && !recentIds.has(m.id)).map(m => m.id);
        mergeMessages([], { remove: stale });
      }
      else for (const m of data.messages) recentIds.add(m.id);
      mergeMessages(data.messages, { remove: data.type === 'update' ? data.removed || [] : [] });
      syncLiveOrder(data.order || data.messages.map(m => m.id));
      renderRequests(data.requests); updateComposer();
      displayedCompletionKey=data.completionKey || null;
      liveStatusAt.set(id,Date.now());if(liveStatusAt.size>500)liveStatusAt.delete(liveStatusAt.keys().next().value);
      paintThreadStatus(id,status,displayedCompletionKey,data.completedAt,'ready');
      if (followBottom) $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
      else if (data.type === 'update' && data.messages?.length) hasUnread = true;
      requestAnimationFrame(markCurrentCompletionRead);
      updateJump(); return;
    }
    if (data.type === 'error') toast(data.message);
  };
  source.onerror = () => {
    if (generation !== openGeneration) return;
    writable = false; offline('网页与电脑的连接中断，正在恢复。历史和草稿仍可查看。'); setConnection('连接中断，正在恢复…', false); renderRequests(requestsNow); updateComposer();
    api('/api/status').then(status=>{csrf=status.csrf;}).catch(() => {});
  };
}
async function openThread(id, title) {
  clearTimeout(desktopOpenTimer);
  if (currentId) { drafts.set(currentId, $('draft').value); saveContext(); }
  currentId = id; const generation = ++openGeneration; disconnect();
  displayedCompletionKey=null;
  expandFromId = loadExpansion(id); olderOutsideRange = new Set(); manualProgress.clear();
  selectedSkills = contexts.get(id)?.skills || []; selectedThreads = contexts.get(id)?.threads || []; renderContext();
  requestSignature = ''; requestsNow = []; $('picker-overlay').hidden = true; $('settings-overlay').hidden = true; closeImage();
  writable = false; busy = false; uncertain = false; sending = false; historyCursor = null;
  messageMap.clear(); messageNodes.clear(); messageOrder = []; recentIds = new Set(); recentTurnIds = new Set(); $('messages').replaceChildren(); $('requests').replaceChildren();
  $('empty').hidden = true; $('thread-title').textContent = title || '正在加载会话'; $('draft').value = drafts.get(id) || '';
  sessionStorage.setItem('rc_thread', id); setSidebar(false); banner(''); offline(''); setConnection('正在读取最近消息…', false); updateComposer();
  sessionStorage.setItem('rc_thread_' + activeProvider, id); $('integration-panel').hidden = true;
  for (const el of $('threads').children) el.classList.toggle('selected', el.dataset.id === id);
  try {
    const page = await api(threadPath(id, 'history'));
    if (generation !== openGeneration) return;
    mergeMessages(page.messages); historyCursor = page.cursor; $('older').hidden = !historyCursor;
    $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
    if (page.messages.length && page.completionKey) { displayedCompletionKey=page.completionKey; requestAnimationFrame(markCurrentCompletionRead); }
    connectEvents(id, generation);
  } catch (err) { toast(err.message); $('empty').hidden = false; }
}
async function ready() {
  try {
    const status = await api('/api/status'); csrf = status.csrf;
    desktopOpenAvailable = !!status.features?.openDesktop;
    loadQuota();
    $('pair-view').hidden = true; $('workspace').hidden = false;
    $('device-name').textContent = status.computer;
    $('device-status').textContent = status.connected ? 'Codex 已连接' : '等待 Codex 打开';
    $('device-dot').className = 'dot' + (status.connected ? '' : ' warn');
    providerInfo = (await api('/api/providers')).providers; $('provider-select').value = activeProvider;
    await loadThreads();
  } catch { showPair(); }
}
function renderIntegration(error = '') {
  const provider = providerInfo.find(p => p.id === activeProvider);
  $('integration-panel').hidden = false; $('empty').hidden = true;
  $('integration-title').textContent = `${providerNames[activeProvider]} · ${activeProvider === 'claude' ? '尚未接通' : provider?.configured ? '等待电脑连接' : '需要申请官方授权'}`;
  $('integration-description').textContent = error || (activeProvider === 'claude' ? '你正在使用的 Claude 桌面聊天尚未接入，当前不能在这里收发消息。电脑上已有的聊天可以继续正常使用。' : provider?.description || '连接状态暂不可用，请刷新重试');
  $('integration-note').textContent = activeProvider === 'claude' ? '目前准备好的接法适用于从命令窗口启动的 Claude Code，尚未验证接入你的现有桌面会话。' : '账号授权在电脑完成；手机不会保存你的 WorkBuddy 账号凭据。';
  $('integration-steps').hidden = activeProvider !== 'workbuddy' || provider?.configured; $('integration-steps').replaceChildren();
  if (activeProvider === 'workbuddy') for (const step of ['进入 WorkBuddy 官方开放平台，注册并申请开发者入驻。', '完成平台要求的资质认证，创建第三方应用。', '给应用配置“本地助理读取”和“本地助理调用”权限。', '在电脑完成本人授权，再配置 Remote Coding 连接。']) { const li = document.createElement('li'); li.textContent = step; $('integration-steps').append(li); }
  $('integration-docs').href = activeProvider === 'claude' ? 'https://code.claude.com/docs/en/remote-control' : 'https://open.workbuddy.cn/';
  $('integration-docs').textContent = activeProvider === 'claude' ? '查看官方远程控制说明 ↗' : '进入 WorkBuddy 开放平台 ↗';
  $('thread-title').textContent = providerNames[activeProvider]; setConnection('尚未连接电脑端', false);
  $('device-status').textContent = '等待 ' + providerNames[activeProvider]; $('device-dot').className = 'dot warn';
}
async function changeProvider(provider) {
  if (currentId) { drafts.set(currentId, $('draft').value); saveContext(); }
  disconnect(); ++openGeneration; activeProvider = provider; sessionStorage.setItem('rc_provider', provider);
  currentId = null; writable = false; busy = false; sending = false; uncertain = false; listQuery = ''; $('search').value = '';
  currentModel = ''; currentEffort = ''; $('model-label').textContent = providerNames[provider];
  selectedSkills = []; selectedThreads = []; renderContext(); messageMap.clear(); messageNodes.clear(); messageOrder = []; requestsNow = []; requestSignature = '';
  $('messages').replaceChildren(); $('requests').replaceChildren(); $('draft').value = ''; $('older').hidden = true; $('jump-bottom').hidden = true;
  $('picker-overlay').hidden = true; $('settings-overlay').hidden = true; closeImage(); offline(''); banner(''); updateComposer();
  providerInfo = (await api('/api/providers')).providers; await loadThreads();
}
$('provider-select').onchange = () => changeProvider($('provider-select').value).catch(err => toast(err.message));
$('refresh-provider').onclick = async () => { providerInfo = (await api('/api/providers')).providers; await loadThreads(); };
$('pair-form').onsubmit = async event => {
  event.preventDefault(); $('pair-error').textContent = ''; $('pair-submit').disabled = true;
  try { await post('/api/pair', { code: $('pair-code').value.trim(), remember: $('remember-phone').checked }); $('pair-code').value = ''; await ready(); }
  catch (err) { $('pair-error').textContent = err.message; }
  finally { $('pair-submit').disabled = false; }
};
$('open-sidebar').onclick = () => setSidebar(true);
$('close-sidebar').onclick = $('scrim').onclick = () => setSidebar(false);
$('refresh-list').onclick = () => loadThreads();
$('refresh-quota').onclick = () => loadQuota(true);
$('more-threads').onclick = () => loadThreads(true);
$('threads').addEventListener('scroll',()=>{clearTimeout(statusScrollTimer);statusScrollTimer=setTimeout(()=>refreshThreadStatuses(),120);},{passive:true});
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listQuery = $('search').value.trim(); loadThreads(); }, 350); };
$('reconnect').onclick = () => { if (currentId) openThread(currentId, $('thread-title').textContent); else loadThreads(); };
$('retry-connection').onclick = () => $('reconnect').click();
$('open-desktop').onclick = async () => {
  if (!currentId || openingDesktop || activeProvider !== 'codex') return;
  const id = currentId; openingDesktop = true; $('open-desktop').disabled = true;
  try {
    await post(`/api/threads/${id}/open-desktop`, {});
    if (id === currentId) {
      toast('已请求在电脑打开，正在自动连接'); connectEvents(id, openGeneration);
      clearTimeout(desktopOpenTimer);
      desktopOpenTimer = setTimeout(() => {
        if (id === currentId && !writable) banner('打开请求已发出，但桌面还未加载这条记录。已保存的历史仍可查看；请在电脑确认是否有打开错误或不可恢复的旧记录。');
      }, 15000);
    }
  } catch (err) { toast(err.message); }
  finally { openingDesktop = false; if (id === currentId) $('open-desktop').disabled = false; }
};
$('pick-skill').onclick = () => openPicker('skills');
$('pick-thread').onclick = () => openPicker('threads');
$('close-picker').onclick = $('picker-done').onclick = closePicker;
$('picker-overlay').onclick = event => { if (event.target === $('picker-overlay')) closePicker(); };
$('picker-more').onclick = () => loadPicker(true);
let pickerSearchTimer;
$('picker-search').oninput = () => { clearTimeout(pickerSearchTimer); if (pickerMode === 'skills') renderPicker(); else pickerSearchTimer = setTimeout(() => loadPicker(), 250); };
$('close-image').onclick = closeImage;
$('image-size').onclick = () => { const original = $('image-overlay').classList.toggle('original-size'); $('image-size').textContent = original ? '适应屏幕' : '查看原图尺寸'; };
$('image-overlay').onclick = event => { if (event.target === $('image-overlay')) closeImage(); };
$('full-image').onerror = () => { $('image-caption').textContent = '原图片已删除或无法读取，请关闭后刷新会话重试'; };
$('draft').oninput = () => { $('draft').style.height = 'auto'; $('draft').style.height = Math.min(140, $('draft').scrollHeight) + 'px'; updateComposer(); };
$('draft').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('send').disabled) { event.preventDefault(); $('send').click(); } };
$('send').onclick = async () => {
  if ($('send').disabled) return;
  const text = $('draft').value.trim(), id = currentId, generation = openGeneration, messageId = uuid();
  sending = true; updateComposer();
  try {
    const result = await post(threadPath(id, 'send'), { text, messageId, mode:busy && activeProvider === 'codex' ? 'steer' : 'message', skillIds: selectedSkills.map(s => s.id), referenceIds: selectedThreads.map(t => t.id) });
    drafts.delete(id);
    contexts.delete(id);
    if (generation === openGeneration) { selectedSkills = []; selectedThreads = []; renderContext(); $('draft').value = ''; $('draft').style.height = 'auto'; toast(result.kind === 'steered' ? '引导已追加到当前任务' : result.pending ? '已排入本机通道，等待 Claude Code 处理' : '已交给电脑上的 ' + providerNames[activeProvider]); }
  } catch (err) {
    if (generation === openGeneration && (err.unknown || err instanceof TypeError)) { uncertain = true; banner('发送结果暂时无法确认。请先核对桌面是否收到，避免重复发送。'); }
    toast(err.message);
  } finally { if (generation === openGeneration) { sending = false; updateComposer(); } }
};
$('stop').onclick = async () => {
  $('stop').disabled = true;
  try { await post(`/api/threads/${currentId}/stop`, {}); toast('已提交停止请求'); }
  catch (err) { toast(err.message); }
  finally { $('stop').disabled = false; }
};
$('older').onclick = async () => {
  if (!historyCursor) return;
  const generation = openGeneration; $('older').disabled = true;
  try { const page = await api(threadPath(currentId, 'history') + `?before=${historyCursor}`); if (generation !== openGeneration) return; mergeMessages(page.messages, { prepend: true }); historyCursor = page.cursor; $('older').hidden = !historyCursor; }
  catch (err) { toast(err.message); }
  finally { $('older').disabled = false; }
};
$('message-scroll').addEventListener('scroll', () => {updateJump();markCurrentCompletionRead();}, { passive: true });
$('jump-bottom').onclick = () => {
  $('message-scroll').scrollTo({ top: $('message-scroll').scrollHeight,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  hasUnread = false; updateJump();
};
new ResizeObserver(entries => {
  for (const entry of entries) $('workspace').style.setProperty('--composer-height', `${entry.contentRect.height + 24}px`);
}).observe(document.querySelector('.composer-wrap'));

function closeSettings() { $('settings-overlay').hidden = true; $('model-settings').focus(); }
function populateEfforts(preferred) {
  const model = modelCatalog.find(m => m.id === $('model-select').value);
  $('effort-select').replaceChildren();
  for (const value of model?.efforts || []) {
    const option = document.createElement('option'); option.value = value; option.textContent = `${effortNames[value] || value} · ${value}`; $('effort-select').append(option);
  }
  $('effort-select').value = model?.efforts.includes(preferred) ? preferred : model?.defaultEffort || model?.efforts[0] || '';
  $('effort-select').disabled = !model?.efforts.length;
  $('model-description').textContent = model?.description || '';
  $('save-settings').disabled = !model || !$('effort-select').value;
}
$('model-settings').onclick = async () => {
  $('settings-overlay').hidden = false; $('settings-error').textContent = '';
  $('save-settings').disabled = true; $('model-select').disabled = true;
  settingsBaseline = { id: currentId, model: currentModel, effort: currentEffort };
  try {
    const data = await api('/api/models'); modelCatalog = data.models;
    if ($('settings-overlay').hidden || settingsBaseline.id !== currentId) return;
    $('model-select').replaceChildren();
    for (const model of modelCatalog) {
      const option = document.createElement('option'); option.value = model.id;
      option.textContent = model.id + (model.id === currentModel ? '（当前）' : ''); $('model-select').append(option);
    }
    if (modelCatalog.some(m => m.id === currentModel)) $('model-select').value = currentModel;
    $('model-select').disabled = false; populateEfforts(currentEffort); $('model-select').focus();
  } catch (err) { $('settings-error').textContent = err.message; }
};
$('model-select').onchange = () => populateEfforts(currentEffort);
$('close-settings').onclick = closeSettings;
$('settings-overlay').onclick = event => { if (event.target === $('settings-overlay')) closeSettings(); };
document.addEventListener('keydown', event => {
  const overlay = ['image-overlay', 'picker-overlay', 'settings-overlay'].map($).find(el => !el.hidden);
  if (!overlay) return;
  if (event.key === 'Escape') { if (overlay.id === 'image-overlay') closeImage(); else if (overlay.id === 'picker-overlay') closePicker(); else closeSettings(); }
  if (event.key === 'Tab') {
    const controls = Array.from(overlay.querySelectorAll('button:not([disabled]),select:not([disabled]),input:not([disabled])')).filter(el => !el.hidden);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
$('save-settings').onclick = async () => {
  $('save-settings').disabled = true; $('settings-error').textContent = '';
  try {
    const result = await post(`/api/threads/${settingsBaseline.id}/settings`, {
      model: $('model-select').value, effort: $('effort-select').value,
      previousModel: settingsBaseline.model, previousEffort: settingsBaseline.effort,
    });
    if (currentId === settingsBaseline.id) {
      currentModel = result.model; currentEffort = result.effort;
      $('model-label').textContent = `${result.model} · ${effortNames[result.effort] || result.effort}`;
    }
    closeSettings(); toast('已确认同步到电脑，下一轮使用此设置');
  } catch (err) { $('settings-error').textContent = err.message; $('save-settings').disabled = false; }
};
$('logout').onclick = async () => { try { await post('/api/logout', {}); sessionStorage.clear(); showPair(); } catch (err) { toast(err.message); } };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { disconnect(); writable = false; updateComposer(); }
  else if (csrf) { if (currentId) connectEvents(currentId, openGeneration); loadThreads(); loadQuota(); }
});
// Lightweight metadata only; no chat/history reload, including paginated lists.
setInterval(() => {
  if(listIsVisible()&&csrf&&!$('refresh-list').disabled&&$('threads').children.length<=40&&Date.now()-lastListRead>=30000){loadThreads();return;}
  refreshThreadStatuses();
}, 5000);
setInterval(() => {
  if (!document.hidden && csrf && ($('sidebar').classList.contains('open') || window.matchMedia('(min-width: 721px)').matches)) loadQuota();
}, 60000);
window.addEventListener('pagehide', disconnect);
async function init() {
  const pairing = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (pairing) {
    history.replaceState(null, '', location.pathname); $('pair-code').value = pairing;
    $('pair-form').requestSubmit();
  } else await ready();
}
init();
