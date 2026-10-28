import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import http from 'node:http';
import {audioSources,ImageStore,serveAudio} from '../src/attachments.mjs';
import {messageFromItem,messagesFromTurns} from '../src/state.mjs';
import {wave} from './audio-fixture.mjs';

test('audio attachments and inline previews retain placement without exposing local paths',()=>{
  const path=resolve('.local','音频 example.wav'),text=`新版\n\n![试听](<${path}>)\n\n原版`;
  const view=new ImageStore().project(messageFromItem({id:'sound',type:'agentMessage',text}),'chat');
  assert.equal(view.audios.length,1);assert.equal(view.audios[0].name,'试听');
  assert.match(view.audios[0].url,/^\/api\/audios\/[a-f0-9]{64}$/);
  assert.ok(view.mediaText.includes(`[rc-media:${view.audios[0].id}]`));
  assert.equal(JSON.stringify(view).includes(path),false);assert.equal(view.audioSources,undefined);
  assert.equal(audioSources({},'```md\n'+text+'\n```').length,0);
  for(const remote of ['https://example.com/sound.wav','//server/share/sound.wav','\\\\server\\share\\sound.wav'])assert.equal(audioSources({},`[音频](${remote})`).length,0);
  assert.equal(messagesFromTurns([{id:'t',items:[{id:'u',type:'userMessage',content:[{type:'localAudio',path}]}]}])[0].audioSources.length,1);
});

test('audio streams validate content and support seek, HEAD, download and bounded cleanup',async()=>{
  mkdirSync(resolve('.local'),{recursive:true});const dir=mkdtempSync(join(resolve('.local'),'test-audio-'));
  const store=new ImageStore();let server;
  try {
    const path=join(dir,'sample.wav'),bytes=wave();writeFileSync(path,bytes);
    const sound=store.project({audioSources:[{path,name:'试听'}]},'chat').audios[0];
    const other=store.project({audioSources:[{path,name:'试听'}]},'other').audios[0];assert.notEqual(sound.id,other.id);
    await assert.rejects(store.openAudio('missing'),/过期/);
    const video=store.project({videoSources:[{path,name:'wrong kind'}]},'chat').videos[0];await assert.rejects(store.openAudio(video.id),/过期/);
    server=http.createServer(async(req,res)=>{try{await serveAudio(req,res,store,sound.id,{download:req.url.includes('download')});}catch{if(!res.headersSent){res.writeHead(404);res.end();}else res.destroy();}});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+server.address().port;
    const part=await fetch(url,{headers:{Range:'bytes=44-75'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(44,76));
    const head=await fetch(url,{method:'HEAD'});assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);
    const bad=await fetch(url,{headers:{Range:'bytes=999999-'}});assert.equal(bad.status,416);await bad.arrayBuffer();
    const download=await fetch(url+'/?download=1');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    writeFileSync(path,'not an audio file');assert.equal((await fetch(url)).status,404);assert.equal(store.activeStreams,0);
  } finally {if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}assert.ok(resolve(dir).startsWith(resolve('.local')+'\\'));rmSync(dir,{recursive:true,force:true});}
});
