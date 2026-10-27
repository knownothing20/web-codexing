// Page-memory only. A held message cannot cause a request by observing a turn.
export function createOutbox({newId=()=>crypto.randomUUID()}={}) {
  const entries=new Map();
  const list=threadId=>[...entries.values()].filter(e=>e.threadId===threadId);
  function hold(threadId,payload){
    if(entries.size>=20||list(threadId).length>=5)throw new Error('待发送已满，请先发送或移除暂存消息');
    const entry={id:newId(),requestId:newId(),threadId,payload,state:'held',waitFor:null,error:''};entries.set(entry.id,entry);return entry;
  }
  function arm(id,view){
    const entry=entries.get(id);
    if(!entry||['sending','unknown'].includes(entry.state)||!view?.writable||!view.busy||!view.turnId)return false;
    for(const other of list(entry.threadId))if(other.state==='armed'){other.state='held';other.waitFor=null;other.error='已改为等待手动发送';}
    entry.state='armed';entry.waitFor=view.turnId;entry.error='';return true;
  }
  function reserve(id){const e=entries.get(id);if(!e||['sending','unknown'].includes(e.state))return null;e.state='sending';e.error='';return e;}
  function observe(threadId,view){
    if(!view?.writable)return null;
    for(const e of list(threadId))if(e.state==='armed'){
      if(view.busy){if(view.turnId&&view.turnId!==e.waitFor){e.state='held';e.error='会话已进入另一轮，请手动发送';}continue;}
      if(view.status==='stopped'||view.status==='error'||view.completionKey&&view.completionKey!==e.waitFor){e.state='held';e.error='本轮已停止或发生变化，请手动发送';continue;}
      if(view.status==='idle'&&!view.completionKey&&!view.pendingCount){e.state='held';e.error='无法确认本轮完成，请手动发送';continue;}
      if(!view.pendingCount&&view.completionKey===e.waitFor)return reserve(e.id);
    }
    return null;
  }
  function fail(id,error,unknown=false){const e=entries.get(id);if(!e)return;e.state=unknown?'unknown':'held';e.error=error;e.waitFor=null;if(!unknown)e.requestId=newId();}
  function pause(id){const e=entries.get(id);if(!e||['sending','unknown'].includes(e.state))return false;e.state='held';e.waitFor=null;e.error='';return true;}
  function remove(id){const e=entries.get(id);if(!e||e.state==='sending')return null;entries.delete(id);return e;}
  function disarmAll(){for(const e of entries.values())if(e.state==='armed'){e.state='held';e.waitFor=null;e.error='连接验证已变化，请手动发送';}}
  return {list,hold,arm,pause,reserve,observe,fail,remove,disarmAll,clear:()=>{const all=[...entries.values()];entries.clear();return all;},get:id=>entries.get(id),done:id=>entries.delete(id)};
}
