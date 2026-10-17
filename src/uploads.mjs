import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

export const MAX_UPLOAD = 20 * 1024 * 1024;
export function safeFileName(value) {
  const name = String(value || '附件').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').slice(0,120).trim();
  return name && !/^\.+$/.test(name) ? name : '附件';
}
export class UploadStore {
  constructor(runtime) { this.root = resolve(runtime,'uploads'); this.entries = new Map(); this.bytes = 0; this.processing = false; }
  async add({sid,threadId,name,image,bytes}) {
    if (!bytes.length || bytes.length > MAX_UPLOAD) throw new Error('每个附件需在 20 MB 以内');
    this.prune();
    this.pruneOrphans();
    if (this.processing) throw new Error('正在处理图片，请稍后重试');
    if (this.entries.size >= 64 || this.bytes + bytes.length > 128 * 1024 * 1024) throw new Error('待发送附件过多，请先发送或移除');
    this.processing = true;
    try {
      name = safeFileName(name); let stored = bytes, suffix = extname(name).replace(/[^.a-z0-9]/gi,'').slice(0,12);
      if (image) {
        try {
          const {default:sharp} = await import('sharp');
          const source = sharp(bytes,{limitInputPixels:40000000,animated:false});
          const meta = await source.metadata();
          if (!['png','jpeg','webp','gif','heif'].includes(meta.format)) throw new Error();
          stored = await source.rotate().resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true}).png().toBuffer(); suffix = '.png';
          if (stored.length > MAX_UPLOAD) throw new Error();
        } catch { throw new Error('图片无法读取或过大，请选择 PNG、JPG、WebP 或 GIF 截图'); }
      }
      if (this.bytes + stored.length > 128 * 1024 * 1024) throw new Error('待发送附件过多，请先发送或移除');
      const id = randomUUID(); mkdirSync(this.root,{recursive:true});
      const path = join(this.root,id+suffix); writeFileSync(path,stored,{flag:'wx'});
      this.entries.set(id,{id,sid,threadId,path,name,image,size:stored.length,created:Date.now()}); this.bytes += stored.length;
      return {id,name,image,size:stored.length};
    } finally { this.processing = false; }
  }
  resolve(ids,sid,threadId) {
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('每条消息最多 8 个附件');
    return ids.map(id => {
      const entry = this.entries.get(id);
      if (!entry || entry.sid !== sid || entry.threadId !== threadId || Date.now()-entry.created > 86400000) throw new Error('附件已失效或不属于此会话，请重新选择');
      return entry;
    });
  }
  retain(entries) { for (const entry of entries) {writeFileSync(entry.path+'.keep','',{flag:'w'});entry.retained = true;} }
  forget(entries) { for (const entry of entries) if (this.entries.delete(entry.id)) this.bytes -= entry.size; }
  remove(id,sid) {
    const entry = this.entries.get(id); if (!entry || entry.sid !== sid) return;
    if (!entry.retained) try { unlinkSync(entry.path); } catch {}
    this.entries.delete(id); this.bytes -= entry.size;
  }
  prune() { for (const entry of this.entries.values()) if (Date.now()-entry.created > 86400000) this.remove(entry.id,entry.sid); }
  pruneOrphans() {
    if(this.scannedAt && Date.now()-this.scannedAt<86400000)return;
    this.scannedAt=Date.now();
    let files;try{files=readdirSync(this.root,{withFileTypes:true});}catch{return;}
    for(const file of files.slice(0,2000)){
      if(!file.isFile()||!/^[0-9a-f-]{36}(?:\.[a-z0-9]{0,11})?$/i.test(file.name))continue;
      const path=join(this.root,file.name);
      try{if(!existsSync(path+'.keep')&&Date.now()-lstatSync(path).mtimeMs>86400000)unlinkSync(path);}catch{}
    }
  }
}
