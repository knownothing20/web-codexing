import { watch } from 'node:fs';

// One shared directory watcher, only while a phone has an open event stream.
// File changes coalesce; the existing SSE heartbeat reconciles missed FS events.
// No periodic timer, new phone connection, persistent chat subscription, or image projection.
export class ActivityFeed {
  constructor(catalog, statuses, { watchDirectory = watch, now = Date.now, batchMs = 1000 } = {}) {
    Object.assign(this, { catalog, statuses, watchDirectory, now, batchMs });
    this.listeners = new Set(); this.rows = new Map(); this.lastScan = -Infinity;
    this.changed = () => this.schedule();
    this.fileChanged = (_, filename) => {
      if (!filename || /^(state_5|thread_history_1)\.sqlite(?:-wal)?$/.test(String(filename))) this.schedule(true);
    };
  }
  subscribe(send) {
    if (!this.listeners.size) {
      this.statuses.on('change', this.changed);
      try {
        this.watcher = this.watchDirectory(this.catalog.home, { persistent: false }, this.fileChanged);
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      } catch { /* Existing SSE heartbeats still reconcile metadata. */ }
    }
    this.scan(false);
    this.listeners.add(send);
    send({ type: 'activity', initial: true, threads: [...this.rows.values()], removedIds: [] });
    this.schedule(true);
    return () => {
      this.listeners.delete(send);
      if (!this.listeners.size) this.stop();
    };
  }
  schedule(observe = false) {
    if (!this.listeners.size) return;
    this.observeNext ||= observe;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const observe = this.observeNext; this.observeNext = false;
      this.scan(observe);
    }, Math.max(25, this.batchMs - (this.now() - this.lastScan)));
    this.timer.unref?.();
  }
  reconcile() { this.schedule(true); }
  scan(observe) {
    this.lastScan = this.now();
    try {
      const recent = this.catalog.list({ limit: 40 });
      const states = this.statuses.read(recent.map(row => row.id), { observe: false });
      const byId = new Map(recent.map(row => [row.id, row]));
      const next = new Map(states.map(row => [row.id, {
        id: row.id, title: byId.get(row.id)?.title || '未命名会话', status: row.status,
        availability: row.availability, pendingCount: row.pendingCount, pendingKey: row.pendingKey,
        completionKey: row.completionKey, completedAt: row.completedAt,
      }]));
      const candidates = states.filter(row => ['running','waiting'].includes(row.status) || byId.get(row.id)?.status === 'running' ||
        row.status === 'stopped' && (['running','waiting'].includes(this.rows.get(row.id)?.status) ||
          this.now() - row.updatedAt < 15 * 60000)).map(row => row.id);
      const removedIds = [...this.rows.keys()].filter(id => !next.has(id));
      const threads = [...next.values()].filter(row => JSON.stringify(this.rows.get(row.id)) !== JSON.stringify(row));
      this.rows = next;
      if ((threads.length || removedIds.length) && this.listeners.size)
        for (const send of this.listeners) send({ type: 'activity', threads, removedIds });
      if (observe) {
        // Idle/completed rows need metadata only. Active candidates share the
        // existing list budget (two workers, four full snapshots / five seconds).
        if (candidates.length) this.statuses.read(candidates);
      }
    } catch { /* SQLite can briefly be busy; retain the last consistent snapshot. */ }
  }
  stop() {
    clearTimeout(this.timer); this.timer = null; this.observeNext = false;
    this.watcher?.close(); this.watcher = null;
    this.statuses.off('change', this.changed); this.rows.clear(); this.lastScan = -Infinity;
  }
  close() { this.listeners.clear(); this.stop(); }
}
