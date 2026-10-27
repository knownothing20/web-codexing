import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOutbox} from '../public/outbox.js';
let serial=0;const box=()=>createOutbox({newId:()=>String(++serial)});
const payload={text:'先检查，不执行',files:[],skills:[],references:[]};
const active={writable:true,busy:true,turnId:'one',status:'running',pendingCount:0};
const completed={writable:true,busy:false,completionKey:'one',status:'idle',pendingCount:0};
test('held messages remain local across completion and reconnect until manually reserved',()=>{
  const q=box(),e=q.hold('chat',payload);
  assert.equal(q.observe('chat',completed),null);assert.equal(q.observe('chat',{...completed,writable:false}),null);
  assert.equal(q.list('chat')[0].state,'held');assert.equal(q.reserve(e.id),e);assert.equal(q.reserve(e.id),null);
});
test('only explicit after-completion choice sends once for the exact original turn',()=>{
  const q=box(),e=q.hold('chat',payload);assert.equal(q.arm(e.id,active),true);
  for(const view of [active,{...completed,pendingCount:1},{...completed,writable:false}])assert.equal(q.observe('chat',view),null);
  assert.equal(q.observe('other',completed),null);assert.equal(q.observe('chat',completed),e);
  assert.equal(q.observe('chat',completed),null);assert.equal(q.reserve(e.id),null);q.done(e.id);assert.equal(q.list('chat').length,0);
});
test('stopped, failed and superseded turns cancel automatic sending rather than steering a new task',()=>{
  for(const changed of [{...completed,status:'stopped',completionKey:null},{...completed,status:'error',completionKey:null},{...completed,completionKey:null},{...active,turnId:'two'},{...completed,completionKey:'two'}]){
    const q=box(),e=q.hold('chat',payload);q.arm(e.id,active);assert.equal(q.observe('chat',changed),null);assert.equal(e.state,'held');
  }
});
test('only one message can be armed per chat; edit/remove/pause do not send',()=>{
  const q=box(),a=q.hold('chat',payload),b=q.hold('chat',payload);q.arm(a.id,active);q.arm(b.id,active);
  assert.equal(a.state,'held');assert.equal(b.state,'armed');q.pause(b.id);assert.equal(q.observe('chat',completed),null);
  assert.equal(q.arm(b.id,completed),false);assert.equal(q.remove(a.id),a);assert.equal(q.get(a.id),undefined);
});
test('unknown results cannot be retried, while known failures require a new manual action',()=>{
  const q=box(),e=q.hold('chat',payload),key=e.requestId;q.reserve(e.id);q.fail(e.id,'connection lost',true);
  assert.equal(e.requestId,key);assert.equal(q.reserve(e.id),null);assert.equal(q.arm(e.id,active),false);assert.equal(q.pause(e.id),false);
  const known=q.hold('chat',payload),previous=known.requestId;q.reserve(known.id);q.fail(known.id,'task changed');
  assert.notEqual(known.requestId,previous);assert.equal(known.state,'held');assert.equal(q.observe('chat',completed),null);
});
test('outbox bounds memory and retains attachment and context ownership per chat',()=>{
  const q=box(),data={...payload,files:[{id:'upload'}],skills:[{id:'skill'}],references:[{id:'reference'}]};
  for(let n=0;n<5;n++)q.hold('chat',data);assert.throws(()=>q.hold('chat',data),/待发送已满/);
  assert.equal(q.list('chat')[0].payload.files[0].id,'upload');assert.equal(q.list('other').length,0);
});
test('a changed pairing session disarms automatic actions and logout clears the page queue',()=>{
  const q=box(),e=q.hold('chat',payload);q.arm(e.id,active);q.disarmAll();assert.equal(e.state,'held');
  assert.equal(q.observe('chat',completed),null);assert.equal(q.clear().length,1);assert.equal(q.list('chat').length,0);
});
