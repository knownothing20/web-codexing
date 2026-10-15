export function tierKind(value) {
  if(value==='priority'||value==='fast')return 'fast';
  if(value==='ultrafast')return 'ultrafast';
  if(value==='default'||value==='standard')return 'standard';
  return value==null?'inherit':'unknown';
}
export function effectiveTier(value,model) {
  if(value!=null)return value;
  const fallback=model?.defaultServiceTier;
  if(fallback==='fast')return model?.serviceTiers?.find(t=>tierKind(t.id)==='fast')?.id || null;
  return fallback || null;
}
export function accelerated(value){return ['fast','ultrafast'].includes(tierKind(value));}
export function fastTier(model){return model?.serviceTiers?.find(t=>tierKind(t.id)==='fast')?.id || null;}
export function sameTier(a,b){return tierKind(a)!=='unknown'&&tierKind(a)===tierKind(b);}
