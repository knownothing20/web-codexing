import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);
export class DesktopOpener {
  constructor({ enabled = process.platform === 'win32', open = execute } = {}) {
    this.enabled = enabled; this.open = open; this.pending = new Map();
  }
  async openThread(id) {
    if (!this.enabled) throw new Error('当前环境不支持打开桌面会话');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('会话 ID 无效');
    const existing = this.pending.get(id);
    if (existing && Date.now() - existing.at < 10000) return existing.result;
    const uri = `codex://threads/${id}?hostId=local`;
    const result = this.open(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${uri}' -ErrorAction Stop`],
      { windowsHide: true, timeout: 10000 }).then(() => ({ requested: true }), () => {
        throw new Error('无法打开 Codex 会话，请确认 Windows 已安装并启动 Codex');
      });
    this.pending.set(id, { at: Date.now(), result });
    for (const [key, entry] of this.pending) if (Date.now() - entry.at >= 10000) this.pending.delete(key);
    return result;
  }
}
