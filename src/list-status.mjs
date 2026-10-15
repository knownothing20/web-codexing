// Shared between phones. No timer while nobody asks for visible list statuses.
export class ListStatus {
  constructor(bridge,catalog,{now=Date.now,probeWindowMs=5000,maxProbes=4}={}) {
    this.bridge=bridge;this.catalog=catalog;this.now=now;this.probeWindowMs=probeWindowMs;this.maxProbes=maxProbes;
    this.cache=new Map();this.queue=[];this.queued=new Set();this.active=0;this.windowAt=0;this.started=0;this.closed=false;
    this.attempted=new Map();
    this.recordStamps=new Map();
    this.invalidate=id=>this.cache.delete(id);this.reset=()=>this.cache.clear();
    this.capture=value=>{
      if(!this.recordStamps.has(value.id))return;
      this.cache.delete(value.id);this.cache.set(value.id,{stamp:this.recordStamps.get(value.id),observedAt:this.now(),until:this.now()+5000,value});
      if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);
    };
    this.availability=value=>{
      if(!this.recordStamps.has(value.id))return;
      this.cache.delete(value.id);this.cache.set(value.id,{stamp:this.recordStamps.get(value.id),observedAt:this.now(),until:this.now()+30000,value});
      if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);
    };
    bridge.on('status-invalidated',this.invalidate);bridge.on('status',this.reset);bridge.on('thread-status',this.capture);
    bridge.on('thread-availability',this.availability);
  }
  read(ids) {
    const records=this.catalog.statusRecords([...new Set(ids)].slice(0,120)), now=this.now();
    for(const row of records){this.recordStamps.delete(row.id);this.recordStamps.set(row.id,row.stamp);}
    while(this.recordStamps.size>200)this.recordStamps.delete(this.recordStamps.keys().next().value);
    if(now-this.windowAt>=this.probeWindowMs){this.windowAt=now;this.started=0;}
    for(const row of [...records].sort((a,b)=>(this.attempted.get(a.id)||0)-(this.attempted.get(b.id)||0))) {
      const t=this.bridge.threads.get(row.id), cached=this.cache.get(row.id);
      if(t?.owner&&t.state)continue;
      if(cached?.stamp===row.stamp && cached.until>now)continue;
      if(this.queued.has(row.id) || !this.bridge.ipc.clientId)continue;
      // Least-recently observed records get a chance before repeatedly polling busy rows.
      if(this.started+this.queue.length>=this.maxProbes)continue;
      this.queued.add(row.id);this.queue.push(row);
    }
    this.pump();
    return records.map(row=>{
      const t=this.bridge.threads.get(row.id), cached=this.cache.get(row.id);
      const pending=row.pendingIds.filter(id=>!this.bridge.acceptedRequests.has(row.id+':'+id));
      let live=t?.owner&&t.state ? this.bridge.statusOf(row.id,t.state) : cached?.stamp===row.stamp&&(cached.until>now||now-cached.observedAt<60000) ? cached.value : null;
      if(live?.requestIds) {
        const remaining=live.requestIds.filter(id=>!this.bridge.acceptedRequests.has(row.id+':'+id));
        if(remaining.length!==live.pendingCount)live={...live,pendingCount:remaining.length,status:remaining.length?'waiting':live.resumeStatus};
      }
      const availability=!this.bridge.ipc.clientId?'offline':live?.availability || 'unknown';
      const status=live?.status || (pending.length?'waiting':row.status==='running' ? availability==='offline'?'offline':availability==='notLoaded'?'notLoaded':row.status :row.status);
      return {id:row.id,status,availability,pendingCount:live?.pendingCount ?? pending.length,
        completionKey:live?.completionKey!==undefined ? live.completionKey : row.completionKey,completedAt:row.completedAt,updatedAt:row.updatedAt};
    });
  }
  pump() {
    while(!this.closed && this.active<2 && this.queue.length && this.started<this.maxProbes) {
      const row=this.queue.shift();this.active++;this.started++;this.attempted.delete(row.id);this.attempted.set(row.id,this.now());
      const previous=this.cache.get(row.id);
      if(this.attempted.size>200)this.attempted.delete(this.attempted.keys().next().value);
      const pending=row.pendingIds.filter(id=>!this.bridge.acceptedRequests.has(row.id+':'+id));
      const ownerOnly=pending.length>0 || !(['running','stopped'].includes(row.status)||['running','waiting'].includes(previous?.value.status));
      this.bridge.probeStatus(row.id,{ownerOnly}).then(value=>{
        if(this.closed||this.cache.get(row.id)!==previous||this.recordStamps.get(row.id)!==row.stamp)return;
        this.cache.delete(row.id);this.cache.set(row.id,{stamp:row.stamp,observedAt:this.now(),
          until:this.now()+(value && ['running','waiting'].includes(value.status)?5000:ownerOnly&&value?.availability==='ready'?120000:ownerOnly&&value?.availability==='notLoaded'?60000:30000),
          value:value || {availability:this.bridge.ipc.clientId?'unknown':'offline'}});
        if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);
      }).catch(()=>{}).finally(()=>{this.active--;this.queued.delete(row.id);this.pump();});
    }
  }
  close(){this.closed=true;this.queue=[];this.queued.clear();this.bridge.off('status-invalidated',this.invalidate);this.bridge.off('status',this.reset);this.bridge.off('thread-status',this.capture);this.bridge.off('thread-availability',this.availability);}
}
