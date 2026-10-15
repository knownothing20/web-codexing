import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export class PairStore {
  constructor(directory) {
    this.file = join(directory, 'paired-devices.json');
    this.devices = new Map();
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const d of data.devices || []) if (/^[0-9a-f]{64}$/.test(d.hash) && d.expires > Date.now()) this.devices.set(d.hash, d);
    } catch { /* first launch */ }
  }
  hash(token) { return createHash('sha256').update(token).digest('hex'); }
  get(token) { const d = this.devices.get(this.hash(token)); return d?.expires > Date.now() ? d : null; }
  remember(token, expires) {
    this.devices.set(this.hash(token), { hash: this.hash(token), expires, pairedAt: Date.now() }); this.save();
  }
  forget(token) { if (this.devices.delete(this.hash(token))) this.save(); }
  clear() { this.devices.clear(); this.save(); }
  prune() { let changed = false; for (const [key, d] of this.devices) if (d.expires <= Date.now()) { this.devices.delete(key); changed = true; } if (changed) this.save(); }
  save() {
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: 1, devices: [...this.devices.values()] }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
