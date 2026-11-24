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

export const speedNames = { standard: '标准', fast: '加速', ultrafast: '超级加速' };

export function speedKind(value, model) {
  const kind = tierKind(effectiveTier(value, model));
  return kind === 'inherit' ? 'standard' : kind;
}

export function speedPicker(model, { serviceTier, serviceTierKnown, draft = null, modelChanged = false }) {
  const choices = [{ kind: 'standard', id: 'default' }];
  const fast = fastTier(model);
  if (fast) choices.push({ kind: 'fast', id: fast });
  if (model?.serviceTiers?.some(t => t.id === 'ultrafast')) choices.push({ kind: 'ultrafast', id: 'ultrafast' });
  const kind = draft ?? speedKind(serviceTier, model);
  const known = serviceTierKnown && tierKind(serviceTier) !== 'unknown' && kind !== 'unknown';
  const selected = known ? choices.find(choice => choice.kind === kind) : undefined;
  const needsChoice = known && !selected && (modelChanged || draft !== null);
  return { choices, kind, known, selected, needsChoice };
}
