import {imageSources} from './attachments.mjs';

// A native finished image is a display artifact, not arbitrary tool output.
export const generatedHistorySql = `(item_type='imageGeneration' AND json_valid(item_json)
  AND json_extract(item_json,'$.status')='completed'
  AND json_type(item_json,'$.savedPath')='text'
  AND COALESCE(json_type(item_json,'$.failure'),'null')='null')`;
// Never load the multi-megabyte result or revised prompt just to page images.
export const displayItemSql = `CASE WHEN item_type='imageGeneration' THEN
  json_object('type','imageGeneration','id',item_id,'status','completed',
    'savedPath',json_extract(item_json,'$.savedPath')) ELSE item_json END`;

export function generatedImageMessage(item,id,turnId) {
  if(item.type!=='imageGeneration'||item.status!=='completed'||item.failure||typeof item.savedPath!=='string')return null;
  const sources=imageSources({content:[{type:'localImage',path:item.savedPath}]});
  if(!sources.length)return null;
  return {id,turnId,role:'assistant',kind:'generatedImages',text:'生成图片',
    imageSources:sources.map(source=>({...source,generated:true})),branchable:false};
}

export function groupGeneratedImages(messages,order=null) {
  const groups=new Map();
  for(const m of messages)if(m.kind==='generatedImages') {
    if(!groups.has(m.turnId))groups.set(m.turnId,[]);
    groups.get(m.turnId).push(m);
  }
  const after=new Map();
  for(const [turnId,items] of groups) {
    if(order)items.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0));
    const sources=[...new Map(items.flatMap(m=>m.imageSources).map(s=>[s.path,s])).values()].slice(0,32);
    const anchor=messages.findLast(m=>m.turnId===turnId&&m.role==='assistant'&&m.kind==='message'&&m.phase!=='commentary')||items.at(-1);
    const gallery={...items.at(-1),id:`generated:${turnId}`,text:`已生成 ${sources.length} 张图片`,
      imageSources:sources.map((s,i)=>({...s,name:`生成图片 ${i+1}`})),branchable:false};
    after.set(anchor,gallery);
  }
  return messages.flatMap(m=>[...(m.kind==='generatedImages'?[]:[m]),...(after.has(m)?[after.get(m)]:[])]);
}
