import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNotifications, pendingKey } from '../public/notifications.js';
import { createReadTracker } from '../public/read-state.js';
import { ActivityFeed } from '../src/activity.mjs';

const storage = () => { const data = new Map(); return { getItem:key=>data.get(key), setItem:(key,value)=>data.set(key,value) }; };
const waiting = (id='chat', key='question-a') => ({ id, title:'演示会话', status:'waiting', pendingKey:key });

test('pending operations take priority, deduplicate and disappear when actually resolved', () => {
  let now=1;const center=createNotifications(storage(),{now:()=>now++});
  assert.equal(center.observe({id:'done',status:'idle',unread:true,completionKey:'turn'}),true);
  assert.equal(center.observe(waiting()),true);assert.equal(center.observe(waiting()),false);
  assert.deepEqual(center.list().map(n=>n.id),['chat','done']);
  center.observe({id:'chat',status:'running'});assert.deepEqual(center.list().map(n=>n.id),['done']);
  assert.equal(pendingKey(['b','a','a']),pendingKey(['a','b']));
  assert.notEqual(pendingKey(['a']),pendingKey(['b']));
});

test('dismissed receipts survive reconnect/reload, but a replacement question still alerts', () => {
  const saved=storage(),center=createNotifications(saved);center.observe(waiting());center.dismiss('chat');
  const reloaded=createNotifications(saved);assert.equal(reloaded.observe(waiting()),false);
  assert.equal(reloaded.observe(waiting('chat','question-b')),true);
  assert.equal(saved.getItem('rc_notice_receipts_v1').includes('演示会话'),false);
});

test('old completed chats form a baseline and opening current output never flashes a notification', () => {
  const saved=storage(),read=createReadTracker(saved,1000),center=createNotifications(saved);
  const row={id:'chat',status:'idle',completionKey:'old',completedAt:900};
  assert.equal(center.observe({...row,unread:read.observe(row.id,row)}),false);
  read.observe('chat',{status:'running',completionKey:'old'});
  const completed={...row,completionKey:'new',completedAt:1200};
  assert.equal(center.observe({...completed,unread:read.observe('chat',completed)},{visible:true}),false);
  assert.equal(center.list().length,0);
  assert.equal(center.observe(waiting(),{visible:true}),false);assert.equal(center.list()[0].kind,'waiting');
});

test('read/cleared completions stay quiet and bounded storage retains actionable requests first', () => {
  const center=createNotifications(storage(),{limit:2});
  center.observe(waiting('important'));center.observe({id:'a',status:'idle',unread:true,completionKey:'a'});
  center.observe({id:'b',status:'idle',unread:true,completionKey:'b'});
  assert.equal(center.list().length,2);assert.equal(center.list()[0].id,'important');
  center.clearCompleted();assert.equal(center.list().length,1);
  center.observe({id:'b',status:'idle',unread:true,completionKey:'b'});assert.equal(center.list().length,1);
  center.observe({id:'fresh',status:'idle',unread:true,completionKey:'fresh'});center.read('fresh');
  assert.equal(center.list().length,1);
});

function fixture() {
  let closes=0,watched=0,callback,scans=0;
  const rows=[{id:'chat',title:'演示会话',status:'running',updatedAt:Date.now(),privateText:'must never project'}];
  const statuses=new EventEmitter(),probes=[];
  statuses.read=(ids,{observe=true}={})=>{if(observe)probes.push(ids);return rows.filter(row=>ids.includes(row.id));};
  const catalog={home:'unused',list:({limit})=>{scans++;assert.equal(limit,40);return rows;}};
  const feed=new ActivityFeed(catalog,statuses,{batchMs:20,watchDirectory:(_home,_opts,fn)=>{watched++;callback=fn;const watcher=new EventEmitter();watcher.close=()=>closes++;return watcher;}});
  return {feed,rows,statuses,probes,changed:(file='thread_history_1.sqlite-wal')=>callback('change',file),counts:()=>({closes,watched,scans})};
}
const settled=()=>new Promise(resolve=>setTimeout(resolve,60));

test('a recorded active chat remains eligible for cheap recovery checks after it was unloaded',async()=>{
  const statuses=new EventEmitter(),probes=[];
  statuses.read=(ids,{observe=true}={})=>{if(observe)probes.push(ids);return[{id:'chat',status:'notLoaded',availability:'notLoaded'}];};
  const feed=new ActivityFeed({home:'unused',list:()=>[{id:'chat',title:'演示任务',status:'running'}]},statuses,
    {batchMs:10,watchDirectory:()=>{throw new Error('No watcher; heartbeat remains available');}});
  const off=feed.subscribe(()=>{});
  try{await settled();assert.deepEqual(probes,[['chat']]);}finally{off();}
});

test('one shared foreground watcher coalesces database writes, projects metadata only, and closes with last phone',async()=>{
  const f=fixture(),a=[],b=[];
  const offA=f.feed.subscribe(value=>a.push(value)),offB=f.feed.subscribe(value=>b.push(value));
  try {
    await settled();assert.equal(f.counts().watched,1);
    assert.equal(a[0].initial,true);assert.equal(JSON.stringify(a).includes('must never project'),false);
    const before=f.counts().scans;
    f.rows[0].status='waiting';f.rows[0].pendingKey='first';
    for(let n=0;n<100;n++)f.changed();
    await settled();assert.equal(f.counts().scans,before+1);
    assert.equal(a.at(-1).threads[0].status,'waiting');assert.equal(b.at(-1).threads[0].status,'waiting');
    const messages=a.length;f.changed('session.jsonl');await settled();assert.equal(a.length,messages);
    f.rows[0].updatedAt++;f.changed();await settled();assert.equal(a.length,messages);
    offA();assert.equal(f.counts().closes,0);
  } finally {offB();}
  assert.equal(f.counts().closes,1);assert.equal(f.feed.timer,null);assert.equal(f.statuses.listenerCount('change'),0);
});

test('native pending changes flow through the same stream, idle rows never request full probes, heartbeat is a fallback',async()=>{
  const f=fixture(),events=[];f.rows[0].status='idle';
  const off=f.feed.subscribe(value=>events.push(value));
  try {
    await settled();assert.equal(f.probes.length,0);
    f.rows[0].status='waiting';f.rows[0].pendingKey='a';f.statuses.emit('change',[]);
    await settled();assert.equal(events.at(-1).threads[0].status,'waiting');
    f.rows[0].pendingKey='b';f.statuses.emit('change',[]);await settled();assert.equal(events.at(-1).threads[0].pendingKey,'b');
    f.rows[0].status='idle';f.rows[0].completionKey='done';f.feed.reconcile();await settled();
    assert.equal(events.at(-1).threads[0].completionKey,'done');assert.equal(f.probes.length,0);
    f.rows.length=0;f.changed();await settled();assert.deepEqual(events.at(-1).removedIds,['chat']);
  } finally {off();}
});
