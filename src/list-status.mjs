import {EventEmitter} from 'node:events';
import {pendingKey} from '../public/notifications.js';

// Visible rows request observation. Cheap owner checks and full snapshots share
// two workers, but use separate budgets. There is no autonomous polling timer.
export class ListStatus extends EventEmitter {
  constructor(bridge,catalog,{now=Date.now,probeWindowMs=5000,maxProbes=4,maxOwnerChecks=32}={}) {
    super();this.setMaxListeners(20);Object.assign(this,{bridge,catalog,now,probeWindowMs,maxProbes,maxOwnerChecks});
    this.cache=new Map();this.owners=new Map();this.records=new Map();this.revisions=new Map();
    this.attempted=new Map();this.ownerAttempts=new Map();this.recordStamps=new Map();
    this.queue=[];this.queued=new Set();this.ownerQueue=[];this.ownerJobs=new Map();
    this.active=0;this.windowAt=0;this.started=0;this.ownerStarted=0;this.epoch=0;this.closed=false;this.changed=new Set();this.lastPublished=new Map();
    this.invalidate=id=>{this.cache.delete(id);this.bump(id);this.notify(id);};
    this.reset=()=>{this.epoch++;this.cache.clear();this.owners.clear();for(const id of this.records.keys())this.notify(id);};
    this.capture=value=>{
      if(!this.records.has(value.id))return;
      const previous=this.cache.get(value.id)?.value,previousOwner=this.owners.get(value.id)?.value;
      this.bump(value.id);this.put(this.owners,value.id,{value:'ready',at:this.now()});
      this.put(this.cache,value.id,{stamp:this.recordStamps.get(value.id),observedAt:this.now(),until:this.now()+5000,value});
      if(previousOwner!=='ready'||previous?.status!==value.status||previous?.pendingCount!==value.pendingCount||previous?.completionKey!==value.completionKey||pendingKey(previous?.requestIds)!==pendingKey(value.requestIds))this.notify(value.id);
    };
    this.availability=value=>{
      if(!this.records.has(value.id))return;
      this.bump(value.id);this.cache.delete(value.id);this.put(this.owners,value.id,{value:value.availability,at:this.now()});this.notify(value.id);
    };
    bridge.on('status-invalidated',this.invalidate);bridge.on('status',this.reset);
    bridge.on('thread-status',this.capture);bridge.on('thread-availability',this.availability);
  }
  put(map,id,value){map.delete(id);map.set(id,value);if(map.size>200)map.delete(map.keys().next().value);}
  bump(id){this.put(this.revisions,id,(this.revisions.get(id)||0)+1);}
  read(ids,{observe=true}={}) {
    const records=this.catalog.statusRecords([...new Set(ids)].slice(0,120)),now=this.now();
    for(const row of records){if(this.recordStamps.get(row.id)!==row.stamp)this.lastPublished.delete(row.id);this.put(this.records,row.id,row);this.put(this.recordStamps,row.id,row.stamp);}
    if(now-this.windowAt>=this.probeWindowMs){this.windowAt=now;this.started=0;this.ownerStarted=0;}
    if(observe&&!this.closed&&this.bridge.ipc.clientId) {
      const candidates=[...records].sort((a,b)=>(this.attempted.get(a.id)||0)-(this.attempted.get(b.id)||0)||(this.ownerAttempts.get(a.id)||0)-(this.ownerAttempts.get(b.id)||0));
      for(const row of candidates) {
        const t=this.bridge.threads.get(row.id);if(t?.owner&&t.state)continue;
        const owner=this.owners.get(row.id);
        if(owner&&now-owner.at<5000){if(owner.value==='ready')this.enqueueSnapshot(row);continue;}
        if(this.ownerJobs.has(row.id)||this.ownerStarted+this.ownerQueue.length>=this.maxOwnerChecks)continue;
        let finish;const promise=new Promise(resolve=>{finish=resolve;});
        this.ownerJobs.set(row.id,promise);this.ownerQueue.push({row,finish});
      }
      this.pump();
    }
    return records.map(row=>this.project(row));
  }
  async refresh(ids) {
    this.read(ids);
    const jobs=ids.map(id=>this.ownerJobs.get(id)).filter(Boolean);
    if(jobs.length) {
      let timer;
      await Promise.race([Promise.allSettled(jobs),new Promise(resolve=>{timer=setTimeout(resolve,300);timer.unref?.();})]);clearTimeout(timer);
    }
    return this.read(ids,{observe:false});
  }
  enqueueSnapshot(row) {
    const cached=this.cache.get(row.id);
    if(cached?.stamp===row.stamp&&cached.until>this.now())return;
    if(!row.pendingIds.length&&!['running','stopped'].includes(row.status)&&!['running','waiting'].includes(cached?.value.status))return;
    if(this.queued.has(row.id)||this.started+this.queue.length>=this.maxProbes)return;
    this.queued.add(row.id);this.queue.push(row);
  }
  project(row) {
    const now=this.now(),t=this.bridge.threads.get(row.id),cached=this.cache.get(row.id),owner=this.owners.get(row.id);
    const attached=!!(t?.owner&&t.state);
    let live=attached?this.bridge.statusOf(row.id,t.state):cached?.stamp===row.stamp&&(cached.until>now||now-cached.observedAt<60000)?cached.value:null;
    if(live?.requestIds) {
      const remaining=live.requestIds.filter(id=>!this.bridge.acceptedRequests.has(row.id+':'+id));
      if(remaining.length!==live.pendingCount)live={...live,pendingCount:remaining.length,status:remaining.length?'waiting':live.resumeStatus};
    }
    if(!attached&&(!this.bridge.ipc.clientId||['notLoaded','offline'].includes(owner?.value)))live=null;
    const availability=!this.bridge.ipc.clientId?'offline':attached?'ready':owner&&now-owner.at<15000?owner.value:'unknown';
    let status=live?.status||row.status;
    if(status==='running'&&['offline','notLoaded'].includes(availability))status=availability;
    const requests=(live?.requestIds || []).filter(id=>!this.bridge.acceptedRequests.has(row.id+':'+id));
    return {id:row.id,status,availability,pendingCount:live?.pendingCount??0,pendingKey:requests.length?pendingKey(requests):null,
      pendingVerified:availability==='ready'&&!!live&&status==='waiting'&&(live.pendingCount||0)>0,
      completionKey:live?.completionKey!==undefined?live.completionKey:row.completionKey,completedAt:row.completedAt,updatedAt:row.updatedAt};
  }
  notify(id) {
    if(this.closed)return;this.changed.add(id);if(this.changeTimer)return;
    this.changeTimer=setTimeout(()=>{
      this.changeTimer=null;const threads=[...this.changed].map(id=>this.records.get(id)).filter(Boolean).map(row=>this.project(row)).filter(row=>{
        const fingerprint=JSON.stringify(row);if(this.lastPublished.get(row.id)===fingerprint)return false;
        this.put(this.lastPublished,row.id,fingerprint);return true;
      });
      this.changed.clear();if(threads.length)this.emit('change',threads);
    },25);this.changeTimer.unref?.();
  }
  pump() {
    while(!this.closed&&this.active<2) {
      if(this.ownerQueue.length&&this.ownerStarted<this.maxOwnerChecks) {
        const {row,finish}=this.ownerQueue.shift();this.active++;this.ownerStarted++;this.put(this.ownerAttempts,row.id,this.now());
        const previous=this.owners.get(row.id),epoch=this.epoch;
        this.bridge.probeStatus(row.id,{ownerOnly:true}).then(value=>{
          if(this.closed||epoch!==this.epoch||this.owners.get(row.id)!==previous)return;
          this.put(this.owners,row.id,{value:value?.availability||(this.bridge.ipc.clientId?'unknown':'offline'),at:this.now()});
          if(value?.availability==='ready')this.enqueueSnapshot(this.records.get(row.id)||row);this.notify(row.id);
        }).catch(()=>{}).finally(()=>{this.active--;this.ownerJobs.delete(row.id);finish();this.pump();});continue;
      }
      if(!this.queue.length||this.started>=this.maxProbes)break;
      const row=this.queue.shift();this.active++;this.started++;this.put(this.attempted,row.id,this.now());
      const revision=this.revisions.get(row.id)||0,epoch=this.epoch,previous=this.cache.get(row.id),ownerBefore=this.owners.get(row.id);
      this.bridge.probeStatus(row.id).then(value=>{
        if(this.closed||epoch!==this.epoch||(this.revisions.get(row.id)||0)!==revision||this.cache.get(row.id)!==previous||this.recordStamps.get(row.id)!==row.stamp)return;
        this.put(this.cache,row.id,{stamp:row.stamp,observedAt:this.now(),until:this.now()+5000,value:value||{}});
        if(value?.availability&&this.owners.get(row.id)===ownerBefore)this.put(this.owners,row.id,{value:value.availability,at:this.now()});this.notify(row.id);
      }).catch(()=>{}).finally(()=>{this.active--;this.queued.delete(row.id);this.pump();});
    }
  }
  close() {
    this.closed=true;clearTimeout(this.changeTimer);this.changed.clear();this.queue=[];this.queued.clear();
    for(const job of this.ownerQueue)job.finish();this.ownerQueue=[];
    this.bridge.off('status-invalidated',this.invalidate);this.bridge.off('status',this.reset);
    this.bridge.off('thread-status',this.capture);this.bridge.off('thread-availability',this.availability);
  }
}
