import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { messageFromItem, visibleUserText, asyncQuestions } from './state.mjs';

export class Catalog {
  constructor(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
    this.home = resolve(home);
    this.state = this.open('state_5.sqlite');
    this.history = this.open('thread_history_1.sqlite');
    const hasTurns = !!this.history?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_turns'").get();
    const turnColumns = new Set(hasTurns ? this.history.prepare('PRAGMA table_info(thread_turns)').all().map(r=>r.name) : []);
    this.turnStatus = hasTurns ? this.history.prepare(`SELECT status,rollout_ordinal,${turnColumns.has('completed_at')?'completed_at':'NULL'} AS completed_at,${turnColumns.has('turn_id')?'turn_id':'NULL'} AS turn_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1`) : null;
    const columns = new Set(this.state?.prepare('PRAGMA table_info(threads)').all().map(r => r.name) || []);
    // Native recency tracks chat activity; updated_at also changes on metadata reads/settings.
    const candidates = ['recency_at_ms', 'recency_at', 'updated_at_ms', 'updated_at'].filter(name => columns.has(name));
    this.recencySql = candidates.length ? 'COALESCE(' + candidates.map(name =>
      `CASE WHEN ${name}>0 THEN CASE WHEN ${name}<100000000000 THEN ${name}*1000 ELSE ${name} END END`).join(',') + ',0)' : '0';
    this.statusRow = this.state?.prepare(`SELECT id,${this.recencySql} AS updatedAt FROM threads WHERE id=? AND archived=0`);
    this.pendingCache = new Map();
    const itemColumns = new Set(this.history?.prepare('PRAGMA table_info(thread_items)').all().map(r=>r.name) || []);
    this.lastItem = itemColumns.has('rollout_ordinal') ? this.history.prepare('SELECT rollout_ordinal FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1') : null;
    this.lastUpdate = itemColumns.has('updated_at_ordinal') ? this.history.prepare('SELECT updated_at_ordinal FROM thread_items WHERE thread_id=? ORDER BY updated_at_ordinal DESC LIMIT 1') : null;
    // Read at most 120 recent display items. Return only question counts and actual
    // question-reply wrappers; ordinary text, tool output and pictures stay on disk.
    this.questionRows = itemColumns.has('item_json') ? this.history.prepare(`WITH recent AS (
      SELECT item_id,turn_id,item_type,item_json,rollout_ordinal FROM thread_items WHERE thread_id=?
      AND item_type IN ('userMessage','steeringUserMessage','agentMessage') ORDER BY rollout_ordinal DESC LIMIT 120
    ) SELECT item_id,turn_id,item_type,rollout_ordinal,
      CASE WHEN item_type='agentMessage' THEN json_array_length(item_json,'$.questions') END AS questions,
      CASE WHEN item_type!='agentMessage' THEN item_json END AS reply
      FROM recent WHERE json_valid(item_json) AND
      ((item_type='agentMessage' AND json_array_length(item_json,'$.questions')>0)
      OR (item_type!='agentMessage' AND instr(item_json,'<send_user_message_question_reply>')>0))
      ORDER BY rollout_ordinal`) : null;
  }
  open(name) {
    const path = join(this.home, name);
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    return db;
  }
  list({ offset = 0, limit = 40, search = '', since = 0 } = {}) {
    if (!this.state) return [];
    return this.state.prepare(`SELECT id, name, title, cwd, ${this.recencySql} AS list_recency, model FROM threads
      WHERE archived=0 AND (agent_path IS NULL OR agent_path='')
      AND source NOT LIKE '%subagent%' AND (name LIKE ? OR title LIKE ?)
      AND ${this.recencySql} >= ?
      ORDER BY list_recency DESC, id DESC LIMIT ? OFFSET ?`).all(`%${search}%`, `%${search}%`, since, limit, offset)
      .map(r => { const turn=this.turnStatus?.get(r.id); return ({ id: r.id, title: (r.name || r.title || '未命名会话').split('\n')[0].slice(0, 100),
        project: r.cwd?.replace(/^\\\\\?\\/, '').split(/[\\/]/).filter(Boolean).at(-1) || '本机',
        updatedAt: r.list_recency, model: r.model || '',
        status: ({inProgress:'running',completed:'idle',failed:'error',interrupted:'stopped'})[turn?.status] || 'unknown',
        completionKey: turn?.status==='completed' ? turn.turn_id || 'record:'+turn.rollout_ordinal : null,
        completedAt: turn?.status==='completed' && Number(turn.completed_at)>0 ? Number(turn.completed_at)*(Number(turn.completed_at)<100000000000?1000:1) : null }); });
  }
  get(id) {
    return this.state?.prepare('SELECT id, rollout_path, name, title, cwd FROM threads WHERE id=? AND archived=0').get(id);
  }
  statusRecords(ids) {
    const version = this.history?.prepare('PRAGMA data_version').get()?.data_version || 0;
    return ids.flatMap(id => {
      const row=this.statusRow?.get(id); if(!row)return [];
      const turn=this.turnStatus?.get(id);
      const status=({inProgress:'running',completed:'idle',failed:'error',interrupted:'stopped'})[turn?.status] || 'unknown';
      const last=this.lastItem?.get(id)?.rollout_ordinal || 0, updated=this.lastUpdate?.get(id)?.updated_at_ordinal || 0;
      const stamp=[turn?.turn_id,turn?.rollout_ordinal,turn?.status,last,updated].join(':');
      let cached=this.pendingCache.get(id);
      if(!cached || cached.version!==version || cached.stamp!==stamp) {
        if(cached?.stamp===stamp) cached.version=version;
        else {
          const turns=new Map();
          for(const item of this.questionRows?.all(id) || []) {
            if(!turns.has(item.turn_id))turns.set(item.turn_id,{turnId:item.turn_id,status:'completed',items:[]});
            if(item.questions)turns.get(item.turn_id).items.push({type:'agentMessage',id:item.item_id,questions:Array.from({length:Math.min(20,item.questions)},()=>({title:''}))});
            else if(item.reply) {try{turns.get(item.turn_id).items.push(JSON.parse(item.reply));}catch{}}
          }
          // Metadata is a probe hint, never proof of a current operation. Include
          // the actual latest turn even when its tail contains no questions.
          const latest=turns.get(turn?.turn_id)||{turnId:turn?.turn_id,items:[]};
          latest.status=turn?.status;
          turns.delete(turn?.turn_id);
          cached={version,stamp,pendingIds:asyncQuestions({turns:[...turns.values(),latest]}).filter(r=>!r.historical).map(r=>r.id)};
          this.pendingCache.delete(id);this.pendingCache.set(id,cached);
          if(this.pendingCache.size>200)this.pendingCache.delete(this.pendingCache.keys().next().value);
        }
      }
      return [{...row,status,stamp,pendingIds:cached.pendingIds,
        completionKey:turn?.status==='completed' ? turn.turn_id || 'record:'+turn.rollout_ordinal : null,
        completedAt:turn?.status==='completed' && Number(turn.completed_at)>0 ? Number(turn.completed_at)*(Number(turn.completed_at)<100000000000?1000:1) : null}];
    });
  }
  historyPage(id, before = null, limit = 60) {
    const row = this.get(id);
    if (!row) throw new Error('会话不存在或已归档');
    const items = this.history?.prepare(`SELECT item_id,turn_id,rollout_ordinal,item_json,created_at_ms FROM thread_items
      WHERE thread_id=? AND rollout_ordinal<? AND item_type IN ('userMessage','agentMessage','steeringUserMessage')
      ORDER BY rollout_ordinal DESC LIMIT ?`).all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1) || [];
    if (!items.length) {
      if (this.history?.prepare('SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1').get(id)) return { messages: [], cursor: null };
      return this.legacyPage(row, before, limit);
    }
    const hasMore = items.length > limit;
    const page = items.slice(0, limit).reverse();
    const branchable = new Set();
    if (this.turnStatus) {
      const ids=[...new Set(page.map(r=>r.turn_id))], slots=ids.map(()=>'?').join(',');
      const completed=new Set(this.history.prepare(`SELECT turn_id FROM thread_turns WHERE thread_id=? AND status='completed' AND turn_id IN (${slots})`).all(id,...ids).map(r=>r.turn_id));
      // SQLite's single MAX aggregate selects item_id from that final row.
      const last=this.history.prepare(`SELECT turn_id,item_id,MAX(rollout_ordinal) FROM thread_items WHERE thread_id=? AND turn_id IN (${slots}) AND item_type='agentMessage' GROUP BY turn_id`).all(id,...ids);
      for(const row of last)if(completed.has(row.turn_id))branchable.add(row.item_id);
    }
    return { messages: page.map(r => ({ ...messageFromItem(JSON.parse(r.item_json), r.turn_id), branchable:branchable.has(r.item_id), at: r.created_at_ms, timeSource: 'recorded' })).filter(m => m?.text || m?.imageSources?.length || m?.videoSources?.length),
      cursor: hasMore ? page[0].rollout_ordinal : null };
  }
  branchPoint(id,messageId) {
    if (!this.get(id) || !this.history || !this.turnStatus) throw new Error('该历史记录暂不支持分支');
    const row = this.history.prepare("SELECT turn_id,item_json FROM thread_items WHERE thread_id=? AND item_id=? AND item_type='agentMessage'").get(id,messageId);
    if (!row) throw new Error('所选回复尚未保存，请稍后重试');
    const item = JSON.parse(row.item_json);
    if (item.phase === 'commentary' || item.questions?.length) throw new Error('请从一轮已完成的正式回复创建分支');
    const turn = this.history.prepare('SELECT status FROM thread_turns WHERE thread_id=? AND turn_id=?').get(id,row.turn_id);
    const last = this.history.prepare("SELECT item_id FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1").get(id,row.turn_id);
    if (turn?.status !== 'completed' || last?.item_id !== messageId) throw new Error('该轮尚未完成，或所选内容不是本轮最后一条回复');
    return row.turn_id;
  }
  legacyPage(row, before, limit) {
    // Bound disk work on old JSONL histories. Never read arbitrary paths from the client.
    const path = resolve(row.rollout_path);
    const allowed = ['sessions', 'archived_sessions'].some(dir => path.toLowerCase().startsWith((join(this.home, dir) + sep).toLowerCase()));
    if (!allowed) return { messages: [], cursor: null };
    let fd;
    try {
      fd = openSync(path, 'r');
      const end = before ?? Number.MAX_SAFE_INTEGER;
      // A fixed tail prevents long sessions from loading into phone memory at once.
      const { size } = fstatSync(fd);
      const stop = Math.min(end, size);
      const start = Math.max(0, stop - 2 * 1024 * 1024);
      const buffer = Buffer.alloc(stop - start);
      readSync(fd, buffer, 0, buffer.length, start);
      let lines = buffer.toString('utf8').split('\n');
      if (start) lines.shift();
      const found = [];
      let pos = start + (start ? buffer.indexOf(10) + 1 : 0);
      for (const line of lines) {
        const linePos = pos;
        pos += Buffer.byteLength(line) + 1;
        try {
          const e = JSON.parse(line);
          if (e.type !== 'response_item' || e.payload?.type !== 'message') continue;
          const p = e.payload;
          if (!['user', 'assistant'].includes(p.role)) continue;
          const raw = (p.content || []).filter(c => ['input_text', 'output_text'].includes(c.type)).map(c => c.text).join('\n');
          const text = p.role === 'user' ? visibleUserText(raw) : raw;
          if (text.startsWith('# AGENTS.md instructions') || text.startsWith('<environment_context>')) continue;
          const message=messageFromItem({...p,id:p.id||`legacy:${linePos}`,type:p.role==='user'?'userMessage':'agentMessage',text:raw,
            content:[{type:'text',text:raw},...(p.content||[]).filter(c=>!['input_text','output_text'].includes(c.type))]});
          if(!message.text&&!message.imageSources?.length&&!message.videoSources?.length)continue;
          found.push({ ...message,
            at: e.timestamp ? Date.parse(e.timestamp) : null, timeSource: 'recorded', _pos: linePos });
        } catch { /* incomplete tail or non-message */ }
      }
      const page = found.slice(-limit);
      return { messages: page.map(({ _pos, ...m }) => m), cursor: found.length > limit ? page[0]._pos : start || null };
    } catch { return { messages: [], cursor: null }; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  messageTimes(id, ids) {
    if (!this.history || !ids.length) return new Map();
    const rows = this.history.prepare(`SELECT item_id,created_at_ms FROM thread_items WHERE thread_id=? AND item_id IN (${ids.map(() => '?').join(',')})`).all(id, ...ids);
    return new Map(rows.filter(r => r.created_at_ms > 0).map(r => [r.item_id, r.created_at_ms]));
  }
  close() { this.state?.close(); this.history?.close(); }
}
