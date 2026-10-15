import { createHmac, randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

const limit = 24 * 1024 * 1024;
export function imageSources(item, raw = '') {
  const result = [];
  const add = (path, name) => {
    if (typeof path !== 'string' || !/\.(png|jpe?g|gif|webp)$/i.test(path) || !isAbsolute(path) || /^\\\\/.test(path)) return;
    const absolute = resolve(path);
    result.push({ path: absolute, name: name || basename(absolute) });
  };
  if (raw.trimStart().startsWith('# Files mentioned by the user:')) {
    for (const m of raw.matchAll(/^## ([^\r\n]+?): ([^\r\n]+)$/gm)) add(m[2].trim(), m[1]);
  }
  for (const part of item.content || item.input || []) {
    if (part.type === 'localImage') add(part.path);
    if (part.type === 'image' && typeof part.url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(part.url) && part.url.length <= limit * 1.4) result.push({ data: part.url, name: '图片' });
  }
  for (const m of raw.matchAll(/!\[([^\]]*)\]\(<?((?:[A-Za-z]:[\\/]|\/)[^\n]*?\.(?:png|jpe?g|gif|webp))>?\)/gi)) add(m[2], m[1]);
  return [...new Map(result.map(s => [s.path ? (process.platform === 'win32' ? s.path.toLowerCase() : s.path) : s.data, s])).values()];
}
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('图片格式不支持');
}
export class ImageStore {
  constructor() { this.key = randomBytes(32); this.entries = new Map(); }
  project(message, threadId) {
    const { imageSources: sources = [], ...publicMessage } = message;
    const images = sources.map(source => {
      const id = createHmac('sha256', this.key).update(threadId + '\0' + (source.path || source.data)).digest('hex');
      this.entries.delete(id); this.entries.set(id, source);
      if (this.entries.size > 768) this.entries.delete(this.entries.keys().next().value);
      return { id, name: source.name, url: '/api/images/' + id };
    });
    return { ...publicMessage, images };
  }
  async read(id) {
    const source = this.entries.get(id);
    if (!source) throw new Error('图片链接已过期，请刷新会话');
    let bytes;
    if (source.data) bytes = Buffer.from(source.data.slice(source.data.indexOf(',') + 1), 'base64');
    else {
      let file;
      try {
        const path = await realpath(source.path);
        file = await open(path, 'r');
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('图片超过 24 MB，暂不预览');
        bytes = await file.readFile();
      } catch (err) { if (['ENOENT', 'EACCES'].includes(err.code)) throw new Error('原图片已删除或无法读取'); throw err; }
      finally { await file?.close(); }
    }
    if (bytes.length > limit) throw new Error('图片超过 24 MB，暂不预览');
    return { bytes, type: mime(bytes) };
  }
}
