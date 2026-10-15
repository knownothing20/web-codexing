import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {publicConversation,serviceTierState} from '../src/state.mjs';
import {accelerated,effectiveTier,fastTier,sameTier} from '../public/service-tier.js';

function setup(initial='priority',{publish=true}={}) {
 const ipc=new EventEmitter();ipc.clientId='client';ipc.close=()=>{};const calls=[],updates=[];
 const bridge=new Bridge(ipc,{messageTimes:()=>new Map()});
 const state={id:'chat',latestModel:'demo-fast',latestReasoningEffort:'high',latestThreadSettings:{serviceTier:initial,sandboxPolicy:{type:'workspace-write'}},requests:[],turns:[],threadRuntimeStatus:{type:'idle'}};
 const thread={id:'chat',hostId:'local',owner:'owner',state,listeners:new Set([()=>{}]),lastMessages:new Map(),timeCache:new Map(),notify:value=>updates.push(value)};
 bridge.threads.set('chat',thread);let desired;
 ipc.request=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread-follower-update-thread-settings') {
   desired=params.threadSettings;
   if(publish)setTimeout(()=>ipc.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{conversationId:'chat',hostId:'local',change:{type:'snapshot',revision:2,conversationState:{...state,latestModel:desired.model,latestReasoningEffort:desired.effort,latestThreadSettings:{...state.latestThreadSettings,...desired}}}}}),10);
   return{result:{applied:true}};
  }
  if(method==='thread-follower-read-model-settings')return{result:{settings:{model:desired.model,reasoningEffort:desired.effort}}};
  throw new Error('Unexpected request: '+method);
 };
 return {bridge,ipc,calls,updates,thread};
}
const request={model:'demo-fast',effort:'high',previousModel:'demo-fast',previousEffort:'high'};

test('speed aliases and inherited defaults are distinguished from an explicit standard setting',()=>{
 const model={defaultServiceTier:'fast',serviceTiers:[{id:'priority',name:'Fast'}]};
 assert.equal(fastTier(model),'priority');assert.equal(accelerated(effectiveTier(null,model)),true);
 assert.equal(accelerated(effectiveTier('default',model)),false);assert.equal(sameTier('priority','fast'),true);
 assert.equal(sameTier(null,'default'),false);assert.equal(sameTier('unrecognized','unrecognized'),false);
});

test('phone projection includes only the tier and its presence, never private thread settings',()=>{
 const state={id:'chat',turns:[],latestThreadSettings:{serviceTier:'priority',privateSetting:'private-value'}};
 const view=publicConversation(state);assert.equal(view.serviceTier,'priority');assert.equal(view.serviceTierKnown,true);
 assert.equal(JSON.stringify(view).includes('private-value'),false);
 assert.equal(serviceTierState({}).serviceTierKnown,false);
 assert.deepEqual(serviceTierState({latestThreadSettings:{serviceTier:null}}),{serviceTier:null,serviceTierKnown:true});
});

for(const [initial,desired] of [['priority','default'],['default','priority']])test('native speed setting '+initial+' -> '+desired+' waits for actual desktop state',async()=>{
 const {bridge,calls,updates}=setup(initial);
 try {
  const result=await bridge.settings('chat',{...request,serviceTier:desired,previousServiceTier:initial});
  assert.equal(result.serviceTier,desired);assert.equal(result.serviceTierKnown,true);
  assert.deepEqual(calls[0].params.threadSettings,{model:'demo-fast',effort:'high',serviceTier:desired});
  assert.equal(updates.at(-1).serviceTier,desired);assert.equal(calls.length,2);
 }finally{bridge.close();}
});

test('a desktop speed change rejects a stale phone request before any mutation',async()=>{
 const {bridge,calls}=setup('default');
 try{await assert.rejects(bridge.settings('chat',{...request,serviceTier:'priority',previousServiceTier:'priority'}),/加速设置已经改变/);assert.equal(calls.length,0);}finally{bridge.close();}
});

test('an accepted setting without native tier confirmation is never reported as saved',async()=>{
 const {bridge,ipc,thread}=setup('priority',{publish:false});
 bridge.confirmServiceTier=(id,tier)=>Bridge.prototype.confirmServiceTier.call(bridge,id,tier,{timeoutMs:20});
 const listeners=ipc.listenerCount('broadcast');
 try{await assert.rejects(bridge.settings('chat',{...request,serviceTier:'default',previousServiceTier:'priority'}),/尚未确认/);assert.equal(thread.state.latestThreadSettings.serviceTier,'priority');assert.equal(ipc.listenerCount('broadcast'),listeners);}finally{bridge.close();}
});

test('saving only model/effort preserves native Ultrafast and omits all unrelated settings',async()=>{
 const {bridge,calls}=setup('ultrafast');
 try{const result=await bridge.settings('chat',request);assert.equal(result.serviceTier,'ultrafast');assert.deepEqual(calls[0].params.threadSettings,{model:'demo-fast',effort:'high'});}finally{bridge.close();}
});

test('older clients without a tier field cannot receive an invented speed setting',async()=>{
 const {bridge,calls,thread}=setup();delete thread.state.latestThreadSettings.serviceTier;
 try{await assert.rejects(bridge.settings('chat',{...request,serviceTier:'priority',previousServiceTier:null}),/未提供/);assert.equal(calls.length,0);}finally{bridge.close();}
});
