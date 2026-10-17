import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UploadStore,safeFileName,MAX_UPLOAD} from '../src/uploads.mjs';
import {ForkService} from '../src/forks.mjs';
import {copyText} from '../public/clipboard.js';
import {messagesFromTurns} from '../src/state.mjs';
import {Bridge} from '../src/bridge.mjs';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {Catalog} from '../src/catalog.mjs';

function fixture(t){const base=resolve('.local');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'actions-test-'));t.after(()=>{assert.ok(dir.startsWith(base));rmSync(dir,{recursive:true,force:true});});return dir;}
test('uploads bind ownership and chat, preserve sent files and delete removed pending files',async t=>{
  const store=new UploadStore(fixture(t)), bytes=Buffer.from('user document');
  const file=await store.add({sid:'one',threadId:'a',name:'../my-notes.txt',image:false,bytes});
  assert.equal(file.name,'my-notes.txt');assert.equal(Object.hasOwn(file,'path'),false);
  assert.throws(()=>store.resolve([file.id],'two','a'));assert.throws(()=>store.resolve([file.id],'one','b'));
  const entries=store.resolve([file.id],'one','a'),path=entries[0].path;assert.deepEqual(readFileSync(path),bytes);
  store.retain(entries);store.remove(file.id,'one');assert.equal(existsSync(path),true);
  const pending=await store.add({sid:'one',threadId:'a',name:'notes.txt',image:false,bytes});
  const pendingPath=store.resolve([pending.id],'one','a')[0].path;store.remove(pending.id,'one');assert.equal(existsSync(pendingPath),false);
  await assert.rejects(store.add({sid:'one',threadId:'a',name:'empty',bytes:Buffer.alloc(0)}));
  await assert.rejects(store.add({sid:'one',threadId:'a',name:'huge',bytes:Buffer.alloc(MAX_UPLOAD+1)}));
  assert.equal(safeFileName('..\\CON.txt\n'), 'CON.txt_');
});
test('image uploads decode content, orient and bound dimensions; invalid images are rejected',async t=>{
  const store=new UploadStore(fixture(t));const {default:sharp}=await import('sharp');
  await assert.rejects(store.add({sid:'one',threadId:'a',name:'fake.png',image:true,bytes:Buffer.from('<svg>not a raster screenshot</svg>')}));
  const bytes=await sharp({create:{width:5000,height:1000,channels:3,background:'#137040'}}).jpeg().toBuffer();
  const file=await store.add({sid:'one',threadId:'a',name:'screen.jpg',image:true,bytes});
  const [entry]=store.resolve([file.id],'one','a');const meta=await sharp(entry.path).metadata();assert.equal(meta.width,4096);assert.equal(meta.format,'png');assert.equal(meta.exif,undefined);
});
test('only a completed turn final response is a branch point',()=>{
  const items=[{id:'progress',type:'agentMessage',phase:'commentary',text:'working'},{id:'final',type:'agentMessage',text:'done'}];
  assert.deepEqual(messagesFromTurns([{turnId:'t',status:'completed',items}]).map(m=>m.branchable),[false,true]);
  assert.ok(messagesFromTurns([{turnId:'t',status:'inProgress',items}]).every(m=>!m.branchable));
});
test('catalog validates a persisted branch point in its source chat and rejects progress/active/later replies',t=>{
  const dir=fixture(t),id=randomUUID();const d=new DatabaseSync(join(dir,'state_5.sqlite'));
  d.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,agent_path TEXT,source TEXT,model TEXT,rollout_path TEXT)');d.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'Test','Test',dir,1,0,null,'vscode','test','');d.close();
  const h=new DatabaseSync(join(dir,'thread_history_1.sqlite'));
  h.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER);CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT)');
  const insert=h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
  for(const [order,item,turn]of [[1,{id:'progress',type:'agentMessage',phase:'commentary',text:'working'},'done'],[2,{id:'result',type:'agentMessage',text:'done'},'done'],[3,{id:'active-result',type:'agentMessage',text:'pending'},'active']])insert.run(id,turn,order,item.id,item.type,JSON.stringify(item),Date.now());
  h.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(id,'done',1,'completed');h.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(id,'active',3,'inProgress');h.close();
  const catalog=new Catalog(dir);try{assert.equal(catalog.branchPoint(id,'result'),'done');assert.throws(()=>catalog.branchPoint(id,'progress'));assert.throws(()=>catalog.branchPoint(id,'active-result'));assert.throws(()=>catalog.branchPoint(randomUUID(),'result'));assert.equal(catalog.historyPage(id).messages.find(m=>m.id==='result').branchable,true);}finally{catalog.close();}
});
test('branch receipts coalesce requests, survive service restart and never replay an unknown result',async t=>{
  const dir=fixture(t), args={sid:'owner',requestId:randomUUID(),threadId:randomUUID(),lastTurnId:'finished-turn'};let calls=0;
  const options={capability:async()=>{},run:async(_bin,id,turn)=>{calls++;assert.equal(id,args.threadId);assert.equal(turn,args.lastTurnId);await new Promise(r=>setTimeout(r,5));return{id:randomUUID()};}};
  const service=new ForkService(dir,options);const [a,b]=await Promise.all([service.create(args),service.create(args)]);assert.deepEqual(a,b);assert.equal(calls,1);
  assert.deepEqual(await new ForkService(dir,options).create(args),a);assert.equal(calls,1);
  await assert.rejects(service.create({...args,sid:'other'}));
  const unknown={...args,requestId:randomUUID()};const failed=new ForkService(dir,{...options,run:async()=>{calls++;const e=new Error('timeout');e.unknown=true;throw e;}});
  await assert.rejects(failed.create(unknown));await assert.rejects(new ForkService(dir,options).create(unknown),e=>e.unknown);assert.equal(calls,2);
});
test('clipboard denied API uses click fallback and restores the draft caret',async()=>{
  let copied='',focused=false,caret,removed=false;const input={style:{},focus(){},select(){},setSelectionRange(){},remove(){removed=true;}};
  const draft={selectionStart:2,selectionEnd:4,focus(){focused=true;},setSelectionRange(...v){caret=v;}};
  const doc={activeElement:draft,body:{append(){}},createElement:()=>input,execCommand:()=>{copied=input.value;return true;}};
  await copyText('reply',{navigator:{clipboard:{writeText:async()=>{throw new Error('denied');}}},document:doc});
  assert.equal(copied,'reply');assert.ok(focused&&removed);assert.deepEqual(caret,[2,4]);
});
test('attachments route as local images and file references through the existing desktop turn',async()=>{
  const ipc=new EventEmitter();ipc.clientId='test';ipc.close=()=>{};let call;ipc.request=async(method,params)=>{call={method,params};return{result:{accepted:true}};};
  const bridge=new Bridge(ipc,{});bridge.threads.set('thread',{owner:'desktop',hostId:'local',state:{requests:[],turns:[{turnId:'old',status:'completed',items:[]}]}});
  await bridge.send('thread','review these','message',{uploads:[{name:'screen.png',path:'C:/test/screen.png',image:true},{name:'notes.txt',path:'C:/test/notes.txt',image:false}]});
  const input=call.params.turnStart.request.input;assert.equal(call.method,'thread-follower-start-turn');assert.deepEqual(input[1],{type:'localImage',path:'C:/test/screen.png'});assert.match(input[0].text,/## notes.txt: C:\/test\/notes.txt/);assert.match(input[0].text,/## My request:\nreview these/);
  bridge.close();
});
