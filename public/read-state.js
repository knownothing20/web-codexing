// Older completions are a baseline, never inferred unread from an empty browser.
export function createReadTracker(storage, now = Date.now()) {
  const key = 'rc_completion_read_v2';
  let saved;
  try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch {}
  const since = Number.isFinite(saved?.since) && saved.since > 0 ? saved.since : now;
  const seen = new Map((Array.isArray(saved?.seen) ? saved.seen : []).filter(x => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string').slice(-500));
  const observed = new Map();
  const persist = () => {
    while (seen.size > 500) seen.delete(seen.keys().next().value);
    try { storage.setItem(key, JSON.stringify({ since, seen:[...seen] })); } catch {}
  };
  const markRead = (id, completion) => { if (!completion || seen.get(id) === completion) return; seen.delete(id); seen.set(id,completion); persist(); };
  persist();
  return {
    markRead,
    observe(id, { status, completionKey, completedAt }) {
      const previous = observed.get(id);
      observed.set(id, { status, completionKey });
      if (observed.size > 1000) observed.delete(observed.keys().next().value);
      if (status !== 'idle' || !completionKey) return false;
      if (seen.get(id) === completionKey) return false;
      const changed = previous && (['running','waiting'].includes(previous.status) || previous.completionKey && previous.completionKey !== completionKey || previous.unread && previous.completionKey === completionKey);
      const newByTime = Number.isFinite(completedAt) && completedAt > since;
      if (!changed && !newByTime) { markRead(id,completionKey); return false; }
      observed.set(id, { status, completionKey, unread:true }); return true;
    },
  };
}
