import { readCatalog } from './models.mjs';

export function quotaView(raw, now = Date.now()) {
  const map = raw?.rateLimitsByLimitId;
  const entries = map && Object.keys(map).length ? Object.entries(map) : raw?.rateLimits ? [['codex', raw.rateLimits]] : [];
  const buckets = entries.filter(([, value]) => value && typeof value === 'object').map(([key, bucket]) => ({
    name: key === 'codex' ? 'Codex' : String(bucket.limitName || key).slice(0, 60),
    plan: ['free','go','plus','pro','team','business','enterprise','edu'].includes(bucket.planType) ? bucket.planType : null,
    windows: ['primary','secondary'].flatMap(kind => {
      const w = bucket[kind]; if (!w) return [];
      const used = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? Math.min(100, Math.max(0, w.usedPercent)) : null;
      return [{ kind, used, remaining: used === null ? null : 100 - used,
        minutes: Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
        resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null }];
    }),
  }));
  // Deliberately omit account identifiers, credit details and reset-credit IDs.
  return { buckets, updatedAt: now, stale: false };
}

export function createQuotaReader(load = () => readCatalog('account/rateLimits/read', {}), { cacheMs = 60000 } = {}) {
  let cached, until = 0, pending;
  return async () => {
    if (cached && Date.now() < until) return cached;
    if (pending) return pending;
    pending = (async () => {
      try { cached = quotaView(await load()); until = Date.now() + cacheMs; return cached; }
      catch {
        if (!cached) throw new Error('额度暂时无法读取，请稍后刷新');
        until = Date.now() + cacheMs;
        cached = { ...cached, stale: true }; return cached;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}
export const getQuota = createQuotaReader();
