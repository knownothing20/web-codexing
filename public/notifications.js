// Notification receipts contain identifiers only; titles and chat text stay in memory.
export function pendingKey(ids = []) {
  const text = JSON.stringify([...new Set(ids)].sort());
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
}

export function createNotifications(storage, { now = Date.now, limit = 30 } = {}) {
  const key = 'rc_notice_receipts_v1', entries = new Map();
  let saved;
  try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch {}
  const receipts = new Map((Array.isArray(saved) ? saved : [])
    .filter(x => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string').slice(-200));
  const remember = entry => {
    receipts.delete(entry.id); receipts.set(entry.id, entry.token);
    while (receipts.size > 200) receipts.delete(receipts.keys().next().value);
    try { storage.setItem(key, JSON.stringify([...receipts])); } catch {}
  };
  return {
    observe(row, { visible = false } = {}) {
      // History/question metadata alone must never manufacture an action alert.
      if(row.status==='waiting'&&row.pendingVerified!==true){entries.delete(row.id);return false;}
      const kind = row.status === 'waiting' ? 'waiting' : row.status === 'idle' && row.unread && row.completionKey ? 'complete' : null;
      if (!kind) { entries.delete(row.id); return false; }
      const token = kind === 'waiting' ? 'waiting:' + (row.pendingKey || 'pending') : 'complete:' + row.completionKey;
      if (receipts.get(row.id) === token || kind === 'complete' && visible) { entries.delete(row.id); return false; }
      const previous = entries.get(row.id), fresh = previous?.token !== token;
      entries.set(row.id, { id: row.id, title: row.title || '未命名会话', kind, token,
        at: fresh ? now() : previous.at, availability: row.availability });
      while (entries.size > limit) {
        const oldest = [...entries.values()].sort((a,b) => (a.kind === 'waiting') - (b.kind === 'waiting') || a.at - b.at)[0];
        entries.delete(oldest.id);
      }
      return fresh && !visible;
    },
    list: () => [...entries.values()].sort((a,b) => (b.kind === 'waiting') - (a.kind === 'waiting') || b.at - a.at),
    dismiss(id) { const entry = entries.get(id); if (entry) { remember(entry); entries.delete(id); } },
    read(id) { const entry = entries.get(id); if (entry?.kind === 'complete') { remember(entry); entries.delete(id); } },
    remove(id) { entries.delete(id); },
    clearCompleted() { for (const entry of entries.values()) if (entry.kind === 'complete') { remember(entry); entries.delete(entry.id); } },
    reset() { entries.clear(); },
  };
}
