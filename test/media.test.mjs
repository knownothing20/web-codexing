import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import {ImageStore,imageSources,videoSources,byteRange,serveVideo} from '../src/attachments.mjs';
import {messageFromItem,messagesFromTurns} from '../src/state.mjs';
import {Catalog} from '../src/catalog.mjs';

function fixture(){const root=resolve('.local');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'test-media-'));}
function clean(path){assert.ok(resolve(path).startsWith(resolve('.local')+'\\'));rmSync(path,{recursive:true,force:true});}
const movie=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(4096,17)]);

test('media sources recognize attachments and local links, never expose paths or accept remote/UNC files',()=>{
  const photo=resolve('.local','example photo.png'),clip=resolve('.local','sample movie.mp4');
  const raw=`# Files mentioned by the user:\n\n## Photo: ${photo}\n## Movie: ${clip}\n\n## My request:\n看下这些文件`;
  const item={type:'userMessage',id:'u',content:[{type:'text',text:raw}]};
  const store=new ImageStore(),view=store.project(messageFromItem(item),'thread');
  assert.equal(view.images.length,1);assert.equal(view.videos.length,1);
  assert.equal(JSON.stringify(view).includes(resolve('.local')),false);
  assert.match(view.images[0].thumbnailUrl,/\?size=thumb$/);
  assert.equal(videoSources({},`[预览](<${clip}>)`).length,1);
  assert.equal(imageSources({},`![图片](<${photo}>)`).length,1);
  assert.deepEqual(videoSources({},'[remote](https://example.com/sample.mp4)'),[]);
  assert.deepEqual(videoSources({content:[{type:'localVideo',path:'\\\\server\\share\\movie.mp4'}]}),[]);
  const onlyVideo=messagesFromTurns([{id:'t',items:[{id:'v',type:'userMessage',content:[{type:'localVideo',path:clip}]}]}]);
  assert.equal(onlyVideo.length,1);assert.equal(onlyVideo[0].videoSources.length,1);
});

test('thumbnail generation shrinks pixels, coalesces requests and invalidates changed files',async()=>{
  const directory=fixture();
  try {
    const path=join(directory,'large.png');
    const original=await sharp({create:{width:2400,height:1200,channels:3,background:'#547b63'}}).png().toBuffer();
    writeFileSync(path,original);const store=new ImageStore();
    const picture=store.project({imageSources:[{path,name:'large.png'}]},'thread').images[0];
    const [a,b]=await Promise.all([store.thumbnail(picture.id),store.thumbnail(picture.id)]);
    assert.strictEqual(a,b);assert.equal(store.thumbs.size,1);assert.equal(store.thumbJobs.size,0);
    const metadata=await sharp(a.bytes).metadata();assert.equal(metadata.width,480);assert.equal(metadata.height,240);
    assert.equal(metadata.exif,undefined);assert.ok(a.bytes.length<original.length);
    assert.deepEqual((await store.read(picture.id)).bytes,original);
    writeFileSync(path,await sharp({create:{width:64,height:32,channels:3,background:'#204020'}}).png().toBuffer());
    assert.equal((await sharp((await store.thumbnail(picture.id)).bytes).metadata()).width,64);
    await assert.rejects(store.thumbnail('unregistered'),/过期/);
  }finally{clean(directory);}
});

test('collapsed previews keep media placement without paths and leave fenced examples untouched',()=>{
  const path=resolve('.local','preview.png');
  const text=`上面的说明\n\n<details>\n<summary>手机预览图</summary>\n\n![预览](${path})\n\n</details>\n\n后面的说明`;
  const message=messageFromItem({id:'preview',type:'agentMessage',text});
  const view=new ImageStore().project(message,'chat');
  const marker=`[rc-media:${view.images[0].id}]`;
  assert.ok(view.mediaText.indexOf('<summary>手机预览图</summary>')<view.mediaText.indexOf(marker));
  assert.ok(view.mediaText.indexOf(marker)<view.mediaText.indexOf('</details>'));
  assert.equal(view.mediaText.includes(path),false);assert.equal(view.text.includes(marker),false);assert.equal(view.text.includes(path),false);
  const code='```markdown\n'+text+'\n```';
  assert.equal(imageSources({},code).length,0);
  const combined=new ImageStore().project(messageFromItem({id:'mixed',type:'agentMessage',text:text+'\n\n'+code}),'chat');
  assert.ok(combined.mediaText.endsWith(code),'code examples stay literal even if the same media is displayed outside');
});

test('bounded legacy history projects visible media while still hiding instruction-only records',()=>{
  const directory=fixture();let catalog;
  try{
    const sessions=join(directory,'sessions');mkdirSync(sessions);
    const path=join(sessions,'history.jsonl'),clip=join(directory,'movie.mp4');
    const entry=payload=>JSON.stringify({type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'message',...payload}});
    writeFileSync(path,[entry({role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\nprivate instructions'}]}),entry({role:'assistant',content:[{type:'output_text',text:`[视频](${clip})`}]}),entry({role:'user',content:[{type:'localImage',path:join(directory,'photo.png')}]})].join('\n'));
    catalog=new Catalog(directory);const page=catalog.legacyPage({rollout_path:path},null,60);
    assert.equal(page.messages.length,2);assert.equal(page.messages[0].videoSources.length,1);assert.equal(page.messages[1].imageSources.length,1);
    const store=new ImageStore();const visible=page.messages.map(m=>store.project(m,'chat'));
    assert.equal(visible[0].text.trim(),'');assert.equal(visible[0].videoSources,undefined);assert.equal(visible[1].imageSources,undefined);
  }finally{catalog?.close();clean(directory);}
});

test('range parser handles seeking, suffixes and malformed ranges without an unbounded read',()=>{
  assert.deepEqual(byteRange('bytes=2-6',10),{start:2,end:6,partial:true});
  assert.deepEqual(byteRange('bytes=8-',10),{start:8,end:9,partial:true});
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9,partial:true});
  assert.deepEqual(byteRange('bytes=0-999',10),{start:0,end:9,partial:true});
  for(const range of ['bytes=10-','bytes=4-2','bytes=-0','bytes=-','bytes=0-1,4-5','bytes=999999999999999999-','items=0-1'])assert.equal(byteRange(range,10),null);
});

test('video serving supports bounded byte ranges, HEAD, download and error cleanup',async()=>{
  const directory=fixture(),store=new ImageStore();let server;
  try {
    const path=join(directory,'movie.mp4'),bytes=movie();writeFileSync(path,bytes);
    const clip=store.project({videoSources:[{path,name:'movie.mp4'}]},'thread').videos[0];
    const photo=store.project({imageSources:[{path:join(directory,'photo.png'),name:'photo'}]},'thread').images[0];
    await assert.rejects(store.openVideo(photo.id),/过期/);
    server=http.createServer(async(req,res)=>{try{await serveVideo(req,res,store,clip.id,{download:req.url.includes('download')});}catch{if(!res.headersSent){res.writeHead(404);res.end();}else res.destroy();}});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
    const partial=await fetch(base,{headers:{Range:'bytes=4-11'}});
    assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 4-11/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()),bytes.subarray(4,12));
    const tail=await fetch(base,{headers:{Range:'bytes=-3'}});assert.equal((await tail.arrayBuffer()).byteLength,3);
    const head=await fetch(base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);
    const bad=await fetch(base,{headers:{Range:'bytes=99999-'}});assert.equal(bad.status,416);await bad.arrayBuffer();
    const download=await fetch(base+'/?download=1');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    writeFileSync(path,'not a movie');assert.equal((await fetch(base)).status,404);
    assert.equal(store.activeStreams,0);
  }finally{if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}clean(directory);}
});
