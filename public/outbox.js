// Page-memory FIFO. Only one message is sent per completed turn.
export function createOutbox({newId=()=>crypto.randomUUID()}={}) {
  const entries=new Map(),gates=new Map();
  const list=threadId=>[...entries.values()].filter(e=>e.threadId===threadId);
  function hold(threadId,payload){
    if(entries.size>=20||list(threadId).length>=5)throw new Error('待发送已满，请先发送或移除暂存消息');
    const entry={id:newId(),requestId:newId(),threadId,payload,state:'held',waitFor:null,error:''};entries.set(entry.id,entry);return entry;
  }
  function arm(id,view){
    const entry=entries.get(id);
    if(!entry||['sending','unknown'].includes(entry.state)||!view?.writable||!view.busy||!view.turnId)return false;
    entry.state='armed';entry.waitFor=view.turnId;entry.error='';return true;
  }
  function reserve(id){const e=entries.get(id);if(!e||['sending','unknown'].includes(e.state))return null;e.state='sending';e.error='';return e;}
  function observe(threadId,view){
    if(!view?.writable)return null;
    const queue=list(threadId);
    if(queue.some(e=>['sending','unknown'].includes(e.state)))return null;
    const pauseQueue=error=>{gates.delete(threadId);for(const e of queue)if(e.state==='armed'){e.state='held';e.waitFor=null;e.error=error;}};
    const gate=gates.get(threadId);
    if(gate){
      if(view.status==='stopped'||view.status==='error'){pauseQueue('本轮已停止，请点引导继续');return null;}
      const next=view.busy?view.turnId:view.completionKey;
      if(!next||next===gate.previous)return null;
      if(gate.expected?next!==gate.expected:!view.busy){pauseQueue('会话轮次已变化，请点引导继续');return null;}
      for(const e of queue)if(e.state==='armed')e.waitFor=next;
      gates.delete(threadId);
    }
    for(const e of queue)if(e.state==='armed'){
      if(view.busy){if(view.turnId&&view.turnId!==e.waitFor){e.state='held';e.error='会话已进入另一轮，请手动发送';}continue;}
      if(view.status==='stopped'||view.status==='error'||view.completionKey&&view.completionKey!==e.waitFor){e.state='held';e.error='本轮已停止或发生变化，请手动发送';continue;}
      if(view.status==='idle'&&!view.completionKey&&!view.pendingCount){e.state='held';e.error='无法确认本轮完成，请手动发送';continue;}
      if(!view.pendingCount&&view.completionKey===e.waitFor)return reserve(e.id);
    }
    return null;
  }
  function fail(id,error,unknown=false){const e=entries.get(id);if(!e)return;gates.delete(e.threadId);for(const other of list(e.threadId))if(other.state==='armed'){other.state='held';other.error='队列已暂停，请点引导继续';}e.state=unknown?'unknown':'held';e.error=error;e.waitFor=null;if(!unknown)e.requestId=newId();}
  function pause(id){const e=entries.get(id);if(!e||['sending','unknown'].includes(e.state))return false;e.state='held';e.waitFor=null;e.error='';return true;}
  function remove(id){const e=entries.get(id);if(!e||e.state==='sending')return null;entries.delete(id);return e;}
  function disarmAll(){gates.clear();for(const e of entries.values())if(e.state==='armed'){e.state='held';e.waitFor=null;e.error='连接验证已变化，请手动发送';}}
  function done(id,{mode='steer',turnId=null}={}){const e=entries.get(id);if(!e)return;entries.delete(id);if(mode==='message'&&list(e.threadId).some(next=>next.state==='armed'))gates.set(e.threadId,{previous:e.waitFor,expected:turnId});}
  return {list,hold,arm,pause,reserve,observe,fail,remove,disarmAll,clear:()=>{const all=[...entries.values()];entries.clear();gates.clear();return all;},get:id=>entries.get(id),done};
}
