import { createHmac, randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const limit = 24 * 1024 * 1024;
function replaceMediaLinks(text, replace) {
  let fenced=false;
  return text.split('\n').map(line=>{
    if(/^\s*```/.test(line)){fenced=!fenced;return line;}
    return fenced?line:line.replace(/!?\[([^\]]*)\]\(<?((?:[A-Za-z]:[\\/]|\/)[^\n]*?\.(?:png|jpe?g|gif|webp|mp4|m4v|webm|mov))>?\)/gi,replace);
  }).join('\n');
}
function localSources(item, raw, extension, localType) {
  const result = [];
  const add = (path, name) => {
    if(typeof path==='string' && /^\/[A-Za-z]:[\\/]/.test(path))path=path.slice(1);
    if (typeof path !== 'string' || !extension.test(path) || !isAbsolute(path) || /^\\\\/.test(path) || /^\/\//.test(path)) return;
    const absolute = resolve(path);
    result.push({ path: absolute, name: name || basename(absolute) });
  };
  if (raw.trimStart().startsWith('# Files mentioned by the user:')) {
    for (const m of raw.matchAll(/^## ([^\r\n]+?): ([^\r\n]+)$/gm)) add(m[2].trim(), m[1]);
  }
  for (const part of item.content || item.input || []) {
    if (part.type === localType) add(part.path);
    if (localType === 'localImage' && part.type === 'image' && typeof part.url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(part.url) && part.url.length <= limit * 1.4) result.push({ data: part.url, name: '图片' });
  }
  replaceMediaLinks(raw,(link,label,path)=>{add(path,label);return link;});
  return [...new Map(result.map(s => [s.path ? (process.platform === 'win32' ? s.path.toLowerCase() : s.path) : s.data, s])).values()].slice(0, 32);
}
export const imageSources = (item, raw = '') => localSources(item, raw, /\.(png|jpe?g|gif|webp)$/i, 'localImage');
export const videoSources = (item, raw = '') => localSources(item, raw, /\.(mp4|m4v|webm|mov)$/i, 'localVideo');

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || !match[1] && !match[2]) return null;
  let start, end;
  if (!match[1]) { const suffix=Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix<=0) return null; start=Math.max(0,size-suffix);end=size-1; }
  else { start=Number(match[1]);end=match[2]?Number(match[2]):size-1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>=size || end<start) return null;
  return {start,end:Math.min(end,size-1),partial:true};
}
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('图片格式不支持');
}
export class ImageStore {
  constructor() { this.key = randomBytes(32); this.entries = new Map(); this.thumbs=new Map();this.thumbBytes=0;this.thumbJobs=new Map();this.thumbTail=Promise.resolve(); }
  project(message, threadId) {
    const { imageSources: sources = [], videoSources: clips = [], ...publicMessage } = message;
    const register = (source, kind) => {
      const id = createHmac('sha256', this.key).update(threadId + '\0' + kind + '\0' + (source.path || source.data)).digest('hex');
      this.entries.delete(id); this.entries.set(id, {...source,kind});
      if (this.entries.size > 768) this.entries.delete(this.entries.keys().next().value);
      const url='/api/'+(kind==='image'?'images/':'videos/')+id;
      const fileName=source.path?basename(source.path):'image.'+(source.data?.startsWith('data:image/jpeg')?'jpg':source.data?.match(/^data:image\/(\w+)/)?.[1]||'png');
      return { id, name: source.name, fileName, url, ...(kind==='image'?{thumbnailUrl:url+'?size=thumb'}:{}) };
    };
    const images=sources.map(source=>register(source,'image')),videos=clips.map(source=>register(source,'video'));
    // Preserve placement (including collapsed previews) without sending filesystem paths.
    const key=path=>process.platform==='win32'?path.toLowerCase():path;
    const paths=new Map([...sources.map((source,i)=>[source,images[i]]),...clips.map((source,i)=>[source,videos[i]])].filter(([source])=>source.path).map(([source,media])=>[key(source.path),media.id]));
    if(typeof publicMessage.text==='string'&&paths.size){
      let placed=false;
      const mediaText=replaceMediaLinks(publicMessage.text,(link,label,path)=>{
        const normalized=resolve(/^\/[A-Za-z]:[\\/]/.test(path)?path.slice(1):path),id=paths.get(key(normalized));
        if(!id)return link;placed=true;return `\n[rc-media:${id}]\n`;
      });
      if(placed){publicMessage.mediaText=mediaText;publicMessage.text=mediaText.replace(/^\[rc-media:[a-f0-9]{64}\]$/gm,'');}
    }
    return { ...publicMessage, images,videos };
  }
  async read(id) {
    const source = this.entries.get(id);
    if (!source || source.kind!=='image') throw new Error('图片链接已过期，请刷新会话');
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
  async thumbnail(id) {
    const source=this.entries.get(id);
    if(!source || source.kind!=='image')throw new Error('图片链接已过期，请刷新会话');
    let stamp='inline';
    if(source.path){let file;try{file=await open(await realpath(source.path),'r');const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new Error('图片超过 24 MB，暂不预览');stamp=stat.size+':'+stat.mtimeMs;}catch(err){throw new Error(err.code?'原图片已删除或无法读取':err.message);}finally{await file?.close();}}
    const key=id+':'+stamp;
    const cached=this.thumbs.get(key);
    if(cached){this.thumbs.delete(key);this.thumbs.set(key,cached);return cached;}
    if(this.thumbJobs.has(key))return this.thumbJobs.get(key);
    if(this.thumbJobs.size>=12)throw new Error('缩略图正在排队，请点击图片查看原图');
    const job=this.thumbTail.catch(()=>{}).then(async()=>{
      const {bytes}=await this.read(id);
      const {default:sharp}=await import('sharp');sharp.concurrency(1);sharp.cache(false);
      const output=await sharp(bytes,{limitInputPixels:40000000,autoOrient:true}).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:72,effort:2}).toBuffer();
      const image={bytes:output,type:'image/webp'};
      this.thumbs.set(key,image);this.thumbBytes+=output.length;
      while(this.thumbs.size>64||this.thumbBytes>8*1024*1024){const oldest=this.thumbs.keys().next().value;this.thumbBytes-=this.thumbs.get(oldest).bytes.length;this.thumbs.delete(oldest);}
      return image;
    }).finally(()=>this.thumbJobs.delete(key));
    this.thumbTail=job;this.thumbJobs.set(key,job);return job;
  }
  async openVideo(id) {
    const source=this.entries.get(id);
    if(!source || source.kind!=='video')throw new Error('视频链接已过期，请刷新会话');
    let file;
    try {
      file=await open(await realpath(source.path),'r');const stat=await file.stat();
      if(!stat.isFile()||!stat.size)throw new Error('视频文件无法读取');
      const header=Buffer.alloc(16);await file.read(header,0,16,0);
      const extension=extname(source.path).toLowerCase();
      const webm=extension==='.webm'&&header.readUInt32BE(0)===0x1a45dfa3;
      const mp4=['.mp4','.m4v','.mov'].includes(extension)&&header.toString('ascii',4,8)==='ftyp';
      if(!webm&&!mp4)throw new Error('视频格式不支持');
      return {file,size:stat.size,type:webm?'video/webm':extension==='.mov'?'video/quicktime':'video/mp4',name:basename(source.path)};
    }catch(err){await file?.close();throw new Error(err.code?'原视频已删除或无法读取':err.message);}
  }
}

export async function serveVideo(req,res,store,id,{download=false}={}) {
  if((store.activeStreams||0)>=4){res.writeHead(429,{'Retry-After':'2'});res.end();return;}
  store.activeStreams=(store.activeStreams||0)+1;
  let video;
  try {
    video=await store.openVideo(id);
    if(res.destroyed)return;
    const range=byteRange(req.headers.range,video.size);
    if(!range){res.writeHead(416,{'Content-Range':`bytes */${video.size}`,'Accept-Ranges':'bytes'});res.end();return;}
    const headers={'Content-Type':video.type,'Content-Length':range.end-range.start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=300'};
    if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${video.size}`;
    if(download)headers['Content-Disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(video.name);
    res.writeHead(range.partial?206:200,headers);
    if(req.method==='HEAD'){res.end();return;}
    await pipeline(video.file.createReadStream({start:range.start,end:range.end,highWaterMark:64*1024,autoClose:false}),res);
  } finally { try{await video?.file.close();}finally{store.activeStreams--;} }
}
