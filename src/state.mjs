import { imageSources, videoSources } from './attachments.mjs';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function applyPatches(state, patches) {
  for (const { op, path, value } of patches) {
    if (!Array.isArray(path) || path.some(k => forbidden.has(String(k)))) throw new Error('无效补丁路径');
    if (!path.length) { if (op === 'replace') { state = value; continue; } throw new Error('无效根补丁'); }
    let parent = state;
    for (const key of path.slice(0, -1)) {
      if (parent == null || !Object.hasOwn(parent, key)) throw new Error('补丁路径缺失');
      parent = parent[key];
    }
    const key = path.at(-1);
    if (Array.isArray(parent)) {
      if (key === 'length' && op === 'replace' && Number.isSafeInteger(value)) { parent.length = value; continue; }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index > parent.length) throw new Error('无效数组补丁');
      if (op === 'add') parent.splice(index, 0, value);
      else if (op === 'remove') parent.splice(index, 1);
      else if (op === 'replace') parent[index] = value;
      else throw new Error('未知补丁');
    } else {
      if (!parent || typeof parent !== 'object') throw new Error('补丁目标缺失');
      if (op === 'remove') delete parent[key];
      else if (op === 'add' || op === 'replace') parent[key] = value;
      else throw new Error('未知补丁');
    }
  }
  return state;
}

export function orderedTurns(state) {
  const history = state?.turnHistory;
  if (history?.kind === 'canonical') {
    const h = history.history;
    const seen = new Set();
    return h.islands.flatMap(island => island.entries.flatMap(({ value }) => {
      if (seen.has(value) || !h.entitiesByKey[value]) return [];
      seen.add(value);
      return [h.entitiesByKey[value]];
    }));
  }
  return state?.turns || [];
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(c => c.type === 'text' || c.type === 'input_text').map(c => c.text || '').join('\n');
}

export function visibleUserText(text) {
  // Codex stores attachment/UI metadata around the actual user message. Render the user-facing portion.
  if (text.startsWith('<send_user_message_question_reply>')) {
    try {
      const json = text.replace(/^<send_user_message_question_reply>\s*/, '').replace(/\s*<\/send_user_message_question_reply>\s*$/, '');
      return JSON.parse(json).map(answer => answer.answer || '').filter(Boolean).join('\n');
    } catch { /* ordinary literal message stays visible */ }
  }
  const wrapped = /^(?:# Files mentioned by the user:|# Response annotations:|<response-annotations>|<in-app-browser-context\b|<external_codex_apps_open_page>)/.test(text.trimStart());
  if (wrapped && text.includes('## My request:')) {
    return text.slice(text.lastIndexOf('## My request:') + '## My request:'.length).trim();
  }
  if (text.trimStart().startsWith('# Files mentioned by the user:')) return '';
  if (wrapped) return text.replace(/^\s*<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>\s*/, '')
    .replace(/^\s*<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>\s*/, '').trim();
  return text;
}

export function messageFromItem(item, turnId = '', index = 0) {
  const id = item.id || `${turnId}:${index}`;
  if (['userMessage', 'steeringUserMessage'].includes(item.type)) {
    const raw = contentText(item.content || item.input);
    const referenceAt = raw.lastIndexOf('\n\n## Referenced chats with Codex:\n');
    let references = [];
    if (referenceAt >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1));
        if (Array.isArray(parsed) && parsed.every(r => /^[0-9a-f-]{36}$/.test(r.threadId || '') && typeof r.title === 'string')) references = parsed.map(r => ({ id: r.threadId, title: r.title.slice(0, 100) }));
      } catch {}
    }
    const attachments = raw.trimStart().startsWith('# Files mentioned by the user:') ? [...raw.matchAll(/^## ([^\n]+?): [^\n]+$/gm)].map(m => m[1]).filter(name => name !== 'My request') : [];
    return { id, turnId, role: 'user', text: visibleUserText(references.length ? raw.slice(0, referenceAt) : raw), attachments, references,
      skills: (item.content || item.input || []).filter?.(c => c.type === 'skill').map(c => c.name) || [],
      imageSources: imageSources(item, raw), videoSources: videoSources(item, raw),
      questionReply: raw.startsWith('<send_user_message_question_reply>'),
      guidance: item.type==='steeringUserMessage' && !raw.trimStart().startsWith('<send_user_message_question_reply>'), kind: 'message' };
  }
  if (item.type === 'agentMessage') {
    return { id, turnId, role: 'assistant', text: (item.text || '').replace(/:codex-annotation\{index="\d+"\}/g, ''), phase: item.phase || 'final_answer',
      imageSources: imageSources(item, item.text || ''), videoSources: videoSources(item, item.text || ''),
      kind: item.questions?.length ? 'question' : 'message' };
  }
  if (item.type === 'error') return { id, turnId, role: 'system', text: item.message || item.error?.message || '执行发生错误', kind: 'error' };
  // Tool commands, tool output, hidden reasoning and credentials never leave the bridge.
  return null;
}

export function messagesFromTurns(turns) {
  const messages = turns.flatMap(turn => {
    const items = turn.items || [];
    const lastAgent = items.findLast(i=>i.type === 'agentMessage');
    const messages = items.map((item, i) => {
      const m = messageFromItem(item, turn.turnId || turn.id, i);
      return m ? { ...m, branchable:turn.status === 'completed' && item === lastAgent && m.role === 'assistant' && m.phase !== 'commentary' && m.kind !== 'question', at: turn.turnStartedAtMs || null, timeSource: 'turn' } : null;
    }).filter(Boolean);
    if (!items.some(i => i.type === 'userMessage') && turn.params?.input?.length) {
      const text = visibleUserText(contentText(turn.params.input));
      if (text) messages.unshift({ id: `input:${turn.turnId}`, turnId: turn.turnId, role: 'user', kind: 'message', text, at: turn.turnStartedAtMs || null, timeSource: 'turn' });
    }
    return messages;
  }).filter(m => m.text || m.imageSources?.length || m.videoSources?.length);
  let question;
  for (const m of messages) {
    if (m.kind === 'question') { question = m; m.questionAnswered = false; }
    if (m.questionReply && question) { question.questionAnswered = true; question = null; }
  }
  return messages;
}

export function publicConversation(state) {
  const turns = orderedTurns(state);
  const active = state?.threadRuntimeStatus?.type === 'active' || turns.at(-1)?.status === 'inProgress';
  return {
    id: state.id, title: state.title || state.fallbackSearchTitle || '未命名会话',
    model: state.latestModel || '', effort: state.latestReasoningEffort || '',...serviceTierState(state),
    busy: active, turnId: active ? turns.at(-1)?.turnId : null,
    completionKey: !active && turns.at(-1)?.status === 'completed' ? turns.at(-1).turnId || turns.at(-1).id || null : null,
    messages: messagesFromTurns(turns).slice(-120),
    turnIds: turns.map(t => t.turnId || t.id).filter(Boolean),
    requests: [...(state.requests || []).filter(r => !r.completed).map(r => ({
      id: r.id, method: r.method,
      // Only the specific question/approval fields needed by the phone UI.
      questions: r.method === 'item/tool/requestUserInput' ? r.params?.questions : undefined,
      command: r.method === 'item/commandExecution/requestApproval' ? r.params?.command : undefined,
      reason: r.params?.reason,
    })), ...asyncQuestions(state)],
  };
}

export function serviceTierState(state) {
  const settings=state?.latestThreadSettings;
  const known=!!settings&&Object.hasOwn(settings,'serviceTier');
  return {serviceTier:known?settings.serviceTier??null:null,serviceTierKnown:known};
}

// Native pending requests remain authoritative even if a turn stopped. Old async
// questions stay answerable from history, but do not mean the desktop is waiting.
export function conversationStatus(state, requests = null) {
  const latest = orderedTurns(state).at(-1);
  const pending = (requests ?? [...(state.requests || []).filter(r => !r.completed), ...asyncQuestions(state)]).filter(r=>!r.historical);
  if (pending.length) return 'waiting';
  if (state?.threadRuntimeStatus?.type === 'active' || latest?.status === 'inProgress') return 'running';
  return ({ interrupted:'stopped', failed:'error' })[latest?.status] || 'idle';
}

export function asyncQuestions(state) {
  const turns = orderedTurns(state), latest = turns.at(-1);
  const answered = new Set();
  for (const item of turns.flatMap(turn => turn.items || [])) {
    if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue;
    const raw = contentText(item.content || item.input).trim();
    if (!raw.startsWith('<send_user_message_question_reply>')) continue;
    try { for (const answer of JSON.parse(raw.slice(34).replace(/<\/send_user_message_question_reply>\s*$/, '').trim())) answered.add(answer.questionItemId); } catch {}
  }
  return turns.filter(turn => ['inProgress', 'completed'].includes(turn.status)).flatMap(turn =>
    (turn.items || []).filter(item => item.type === 'agentMessage' && item.questions?.length).flatMap(item => {
    const questions = item.questions.map((q, index) => ({ id: JSON.stringify(['request_user_input_async', item.id, index]),
      header: '', question: q.title, isOther: true, isSecret: false,
      options: q.options?.map(label => ({ label, description: '' })) || null })).filter(q => !answered.has(q.id));
    return questions.length ? [{ id: 'async:' + item.id, method: 'remote-coding/asyncUserInput', turnId: turn.turnId,
      historical: turn !== latest || turn.status !== 'inProgress', questions }] : [];
  }));
}
