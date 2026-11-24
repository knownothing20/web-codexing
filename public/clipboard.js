export async function copyText(text, {navigator:nav=globalThis.navigator,document:doc=globalThis.document}={}) {
  try { if (nav.clipboard?.writeText) { await nav.clipboard.writeText(text); return; } } catch { /* User-triggered fallback for denied permission or LAN HTTP. */ }
  const active=doc.activeElement, start=active?.selectionStart, end=active?.selectionEnd;
  const selection=doc.getSelection?.(), ranges=[];
  for(let i=0;i<(selection?.rangeCount||0);i++) ranges.push(selection.getRangeAt(i).cloneRange());
  const input=doc.createElement('textarea'); input.value=text; input.readOnly=true;
  input.style.cssText='position:fixed;left:-9999px;top:0;font-size:16px'; doc.body.append(input);
  let copied=false;
  try { input.focus({preventScroll:true});input.select();input.setSelectionRange(0,text.length);copied=doc.execCommand('copy'); }
  finally {
    input.remove(); active?.focus({preventScroll:true});
    if(typeof start==='number' && typeof active?.setSelectionRange==='function')active.setSelectionRange(start,end);
    if(ranges.length){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}
  }
  if(!copied)throw new Error('浏览器未允许复制，请长按或选中文字复制');
}

export function readMessageSelection(selection, messages) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const bodyOf = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest('button,summary,input,textarea') ? null : element?.closest('.message-body');
  };
  const body = bodyOf(selection.anchorNode);
  if (!body || !messages.contains(body) || body !== bodyOf(selection.focusNode)) return null;
  const text = selection.toString().trim();
  return text ? { text, source: body.closest('.message.user') ? '你' : 'Codex' } : null;
}

export function withQuotedText(text, quote) {
  if (!quote) return text;
  const lines = quote.text.split(/\r\n?|\n/).map(line => '> ' + line);
  return [`> 引用 · ${quote.source}`, ...lines, ...(text ? ['', text] : [])].join('\n');
}
