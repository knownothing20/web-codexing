import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Catalog} from '../src/catalog.mjs';
import {Bridge} from '../src/bridge.mjs';
import {ListStatus} from '../src/list-status.mjs';
import {conversationStatus} from '../src/state.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const questionState=()=>({id:'chat',requests:[{id:'request',method:'item/tool/requestUserInput',params:{questions:[]}}],turns:[{turnId:'turn',status:'interrupted',items:[]}]});

test('pending operations override stopped/completed state and acknowledged operations restore actual state',()=>{
 const state=questionState(),ipc=new EventEmitter();ipc.clientId='client';
 const bridge=new Bridge(ipc,{});ipc.close=()=>{};
 assert.equal(conversationStatus(state),'waiting');
 assert.equal(bridge.statusOf('chat',state).status,'waiting');
 bridge.acknowledge('chat','request');assert.equal(bridge.statusOf('chat',state).status,'stopped');
 state.turns[0].status='inProgress';assert.equal(bridge.statusOf('chat',state).status,'running');
 state.turns[0].status='completed';assert.equal(bridge.statusOf('chat',state).status,'idle');
 state.turns[0].items=[{id:'historical',type:'agentMessage',questions:[{title:'Which?',options:['A','B']}]}];
 assert.equal(bridge.statusOf('chat',state).status,'waiting');
 bridge.acknowledge('chat','async:historical');assert.equal(bridge.statusOf('chat',state).status,'idle');bridge.close();
});

test('persisted question metadata finds pending forms in a stopped chat, caches tails and sees later replies',()=>{
 const base=resolve('.local');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'status-test-'));let catalog,history;
 try {
  const db=new DatabaseSync(join(dir,'state_5.sqlite'));
  db.exec("CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,model TEXT,archived INTEGER,agent_path TEXT,source TEXT,updated_at INTEGER);INSERT INTO threads VALUES('chat','','','','',0,NULL,'vscode',1)");db.close();
  history=new DatabaseSync(join(dir,'thread_history_1.sqlite'));
  history.exec("CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,rollout_ordinal INTEGER);INSERT INTO thread_turns VALUES('chat','old','completed',1),('chat','new','interrupted',3);CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER,updated_at_ordinal INTEGER)");
  const insert=history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
  insert.run('chat','old','q','agentMessage',JSON.stringify({type:'agentMessage',id:'q',questions:[{title:'Choose',options:['A','B']}]}),2,2);
  catalog=new Catalog(dir);let reads=0;const all=catalog.questionRows.all.bind(catalog.questionRows);catalog.questionRows={all:(...args)=>{reads++;return all(...args);}};
  assert.deepEqual(catalog.statusRecords(['chat'])[0].pendingIds,['async:q']);
  assert.equal(catalog.statusRecords(['chat'])[0].status,'stopped');assert.equal(reads,1);
  const reply='<send_user_message_question_reply>'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','q',0]),answer:'A'}])+'</send_user_message_question_reply>';
  insert.run('chat','new','reply','userMessage',JSON.stringify({type:'userMessage',content:[{type:'text',text:reply}]}),4,4);
  assert.deepEqual(catalog.statusRecords(['chat'])[0].pendingIds,[]);assert.equal(reads,2);
  const row=catalog.statusRecords(['chat'])[0];assert.equal(JSON.stringify(row).includes('Choose'),false);assert.equal(reads,2);
 }finally{history?.close();catalog?.close();assert.ok(resolve(dir).startsWith(base+sep));rmSync(dir,{recursive:true,force:true});}
});

test('a bounded status probe discovers a pending operation without loading messages or taking ownership',async()=>{
 const ipc=new EventEmitter();ipc.clientId='client';const follows=[];ipc.close=()=>{};
 const state=questionState();
 ipc.request=async(method)=>{assert.equal(method,'thread-owner-discovery');return{handledByClientId:'owner'};};
 ipc.follow=(id,host,on)=>{follows.push(on);if(on)queueMicrotask(()=>ipc.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{conversationId:id,hostId:host,change:{type:'snapshot',conversationState:state}}}));};
 const bridge=new Bridge(ipc,{messageTimes:()=>{throw new Error('No history projection in status probe');}},{project:()=>{throw new Error('No images in status probe');}});
 const result=await bridge.probeStatus('chat');assert.equal(result.status,'waiting');assert.equal(result.pendingCount,1);
 assert.deepEqual(follows,[true,false]);assert.equal(bridge.threads.size,0);assert.equal(bridge.statusProbes.size,0);assert.equal(Object.hasOwn(result,'messages'),false);bridge.close();
});

test('status probes never unsubscribe a chat opened while the probe is pending',async()=>{
 const ipc=new EventEmitter();ipc.clientId='client';ipc.close=()=>{};const follows=[];
 ipc.request=async()=>({handledByClientId:'owner'});ipc.follow=(id,host,on)=>follows.push(on);
 const bridge=new Bridge(ipc,{}),promise=bridge.probeStatus('chat');await tick();
 bridge.publish=()=>{};
 bridge.threads.set('chat',{id:'chat',listeners:new Set([()=>{}]),owner:'owner',state:null,lastMessages:new Map()});
 ipc.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{conversationId:'chat',hostId:'local',change:{type:'snapshot',conversationState:questionState()}}});
 // This test only needs the probe routing, so avoid a full subscriber projection.
 await promise;assert.deepEqual(follows,[true]);bridge.close();
});

test('cheap lookups do not consume the four-snapshot budget and both lanes share two workers',async()=>{
 let now=1000;const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 const calls=[],owners=[],resolvers=[];let active=0,peak=0;
 bridge.probeStatus=(id,options)=>{active++;peak=Math.max(peak,active);
  if(options?.ownerOnly){owners.push(id);return new Promise(resolve=>queueMicrotask(()=>{active--;resolve({availability:'ready'});}));}
  calls.push(id);return new Promise(resolve=>resolvers.push(()=>{active--;resolve({status:'waiting',availability:'ready',pendingCount:1,completionKey:null});}));
 };
 const records=Array.from({length:10},(_,i)=>({id:'chat-'+i,status:'stopped',stamp:'same',pendingIds:[],completionKey:null}));
 const service=new ListStatus(bridge,{statusRecords:()=>records},{now:()=>now});
 for(let i=0;i<10;i++)service.read(records.map(r=>r.id));await tick();assert.equal(calls.length,2);assert.equal(owners.length,10);
 resolvers.shift()();resolvers.shift()();await tick();assert.equal(calls.length,4);
 resolvers.shift()();resolvers.shift()();await tick();service.read([]);assert.equal(calls.length,4);
 now=7000;service.read(records.map(r=>r.id));await tick();assert.deepEqual(calls.slice(4),['chat-4','chat-5']);assert.equal(peak,2);
 service.close();for(const done of resolvers)done();await tick();
});

test('only confirmed answers suppress pending operations; uncertain outcomes leave them visible',async()=>{
 const ipc=new EventEmitter();ipc.clientId='client';ipc.close=()=>{};ipc.request=async()=>{throw Object.assign(new Error('unknown'),{unknown:true});};
 const bridge=new Bridge(ipc,{}),state=questionState();state.requests[0].params.questions=[{id:'q',question:'choose',isOther:true,options:null}];
 bridge.threads.set('chat',{id:'chat',owner:'owner',hostId:'local',state});
 await assert.rejects(bridge.answer('chat','request',{q:'answer'}),/unknown/);
 assert.equal(bridge.statusOf('chat',state).status,'waiting');assert.equal(bridge.acceptedRequests.size,0);bridge.close();
});

test('existing live updates win over delayed probes and remain cached after leaving a chat',async()=>{
 let now=10000,finish;const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 bridge.probeStatus=()=>new Promise(resolve=>{finish=resolve;});
 const row={id:'chat',status:'stopped',stamp:'same',pendingIds:[],completionKey:null};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]},{now:()=>now});
 service.read(['chat']);
 bridge.emit('thread-status',{id:'chat',status:'waiting',pendingCount:1,requestIds:['request'],resumeStatus:'stopped',completionKey:null});
 finish({status:'stopped',pendingCount:0,completionKey:null});await tick();
 assert.equal(service.read(['chat'])[0].status,'waiting');
 bridge.acceptedRequests.add('chat:request');assert.equal(service.read(['chat'])[0].status,'stopped');
 service.close();assert.equal(bridge.listenerCount('thread-status'),0);
});

test('visible idle rows refresh cheap ownership within five seconds without subscribing to history',async()=>{
 let now=10000,calls=0;const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 const options=[];bridge.probeStatus=async(id,option)=>{calls++;options.push(option);return option?.ownerOnly?{availability:'ready'}:{status:'idle',availability:'ready',pendingCount:0,completionKey:'turn'};};
 const row={id:'chat',status:'idle',stamp:'same',pendingIds:[],completionKey:'turn'};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]},{now:()=>now});
 await service.refresh(['chat']);
 for(let i=0;i<10;i++){now+=5000;await service.refresh(['chat']);}assert.equal(calls,11);assert.ok(options.every(x=>x.ownerOnly));
 bridge.emit('thread-status',{id:'chat',status:'waiting',pendingCount:1,completionKey:'turn'});
 assert.equal(service.read(['chat'])[0].status,'waiting');assert.equal(calls,11);
 now+=5000;await service.refresh(['chat']);await tick();assert.equal(calls,13);assert.equal(options.at(-1)?.ownerOnly,undefined);assert.equal(service.read(['chat'])[0].status,'idle');
 service.close();
});

test('owner-only checks never subscribe to messages and distinguish unloaded chats from connection errors',async()=>{
 const ipc=new EventEmitter();ipc.clientId='client';ipc.close=()=>{};
 ipc.request=async(method,{conversationId})=>{
  assert.equal(method,'thread-owner-discovery');
  if(conversationId==='ready')return{handledByClientId:'owner'};
  if(conversationId==='missing')throw new Error('no-client-found');
  if(conversationId==='failed')throw new Error('request timeout');
  return{};
 };
 ipc.follow=()=>{throw new Error('Owner-only checks must never follow chat messages');};
 const bridge=new Bridge(ipc,{});
 assert.equal((await bridge.probeStatus('ready',{ownerOnly:true})).availability,'ready');
 assert.equal((await bridge.probeStatus('missing',{ownerOnly:true})).availability,'notLoaded');
 assert.equal((await bridge.probeStatus('absent',{ownerOnly:true})).availability,'notLoaded');
 assert.equal((await bridge.probeStatus('failed',{ownerOnly:true})).availability,'unknown');
 assert.equal(bridge.threads.size,0);assert.equal(bridge.statusProbes.size,0);bridge.close();
});

test('unloaded is independent of pending questions and completed/read markers',async()=>{
 const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 const options=[];bridge.probeStatus=async(id,option)=>{options.push(option);return{availability:'notLoaded'};};
 const records=[{id:'completed',status:'idle',stamp:'a',pendingIds:[],completionKey:'old-result'},
  {id:'pending',status:'stopped',stamp:'b',pendingIds:['question'],completionKey:null}];
 const service=new ListStatus(bridge,{statusRecords:()=>records});service.read(records.map(r=>r.id));await tick();
 const [completed,pending]=service.read(records.map(r=>r.id));
 assert.equal(completed.availability,'notLoaded');assert.equal(completed.status,'idle');assert.equal(completed.completionKey,'old-result');
 assert.equal(pending.availability,'notLoaded');assert.equal(pending.status,'waiting');assert.equal(pending.pendingCount,1);
 assert.ok(options.every(option=>option.ownerOnly));service.close();
});

test('an actual attach failure immediately replaces older ready availability without extra probing',async()=>{
 const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();let probes=0;
 bridge.probeStatus=async()=>{probes++;return{availability:'ready'};};
 const row={id:'chat',status:'idle',stamp:'same',pendingIds:[],completionKey:'old'};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]});service.read(['chat']);await tick();
 assert.equal(service.read(['chat'])[0].availability,'ready');
 bridge.emit('thread-availability',{id:'chat',availability:'notLoaded'});
 for(let i=0;i<5;i++)assert.equal(service.read(['chat'])[0].availability,'notLoaded');
 assert.equal(probes,1);service.close();assert.equal(bridge.listenerCount('thread-availability'),0);
});

test('a complete visible batch resolves in one refresh instead of waiting in four-row windows',async()=>{
 const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();let calls=0;
 bridge.probeStatus=async(id,options)=>{assert.equal(options.ownerOnly,true);calls++;return{availability:'notLoaded'};};
 const records=Array.from({length:24},(_,i)=>({id:'chat-'+i,status:'idle',stamp:'same',pendingIds:[],completionKey:'old'}));
 const service=new ListStatus(bridge,{statusRecords:ids=>records.filter(row=>ids.includes(row.id))});
 service.read(records.map(row=>row.id),{observe:false});assert.equal(calls,0);
 const result=await service.refresh(records.map(row=>row.id));assert.equal(calls,24);assert.ok(result.every(row=>row.availability==='notLoaded'));
 await service.refresh(records.map(row=>row.id));assert.equal(calls,24);service.close();
});

test('completed background probes push metadata immediately without another list poll',async()=>{
 const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();let complete;
 bridge.probeStatus=async(id,options)=>options?.ownerOnly?{availability:'ready'}:new Promise(resolve=>{complete=resolve;});
 const row={id:'chat',status:'stopped',stamp:'same',pendingIds:[],completionKey:null};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]});
 const changed=new Promise(resolve=>service.on('change',rows=>{if(rows[0]?.status==='waiting')resolve(rows[0]);}));
 await service.refresh(['chat']);await tick();assert.ok(complete);
 complete({status:'waiting',availability:'ready',pendingCount:1,requestIds:['q'],completionKey:null});
 let timer;const value=await Promise.race([changed,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('status update was not pushed')),1000);})]);clearTimeout(timer);
 assert.equal(value.status,'waiting');assert.equal(Object.hasOwn(value,'requestIds'),false);service.close();
});

test('loading a stopped chat invalidates absence within five seconds and gets its current pending state',async()=>{
 let now=10000,loaded=false;const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 bridge.probeStatus=async(id,options)=>options?.ownerOnly?{availability:loaded?'ready':'notLoaded'}:{status:'waiting',availability:'ready',pendingCount:1,completionKey:null};
 const row={id:'chat',status:'stopped',stamp:'same',pendingIds:[],completionKey:null};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]},{now:()=>now});
 assert.equal((await service.refresh(['chat']))[0].availability,'notLoaded');
 loaded=true;now+=5000;await service.refresh(['chat']);await tick();
 const current=service.read(['chat'],{observe:false})[0];assert.equal(current.availability,'ready');assert.equal(current.status,'waiting');service.close();
});

test('unchanged streaming status does not produce repeated list pushes',async()=>{
 const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 const row={id:'chat',status:'idle',stamp:'same',pendingIds:[],completionKey:'old'};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]});service.read(['chat'],{observe:false});
 let updates=0;service.on('change',()=>updates++);
 const value={id:'chat',status:'running',availability:'ready',pendingCount:0,completionKey:null};
 bridge.emit('thread-status',value);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(updates,1);
 for(let i=0;i<20;i++)bridge.emit('thread-status',value);
 assert.equal(service.changeTimer,null);assert.equal(updates,1);
 bridge.emit('thread-status',{...value,status:'waiting',pendingCount:1});await new Promise(resolve=>setTimeout(resolve,40));assert.equal(updates,2);service.close();
});

test('new native questions in stopped chats are detected without waiting for a database change',async()=>{
 let now=10000,waiting=false;const bridge=new EventEmitter();bridge.ipc={clientId:'client'};bridge.threads=new Map();bridge.acceptedRequests=new Set();
 bridge.probeStatus=async(id,options)=>options?.ownerOnly?{availability:'ready'}:{status:waiting?'waiting':'stopped',availability:'ready',pendingCount:waiting?1:0,completionKey:null};
 const row={id:'chat',status:'stopped',stamp:'unchanged',pendingIds:[],completionKey:null};
 const service=new ListStatus(bridge,{statusRecords:()=>[row]},{now:()=>now});await service.refresh(['chat']);await tick();
 assert.equal(service.read(['chat'],{observe:false})[0].status,'stopped');
 waiting=true;now+=5000;await service.refresh(['chat']);await tick();assert.equal(service.read(['chat'],{observe:false})[0].status,'waiting');service.close();
});
