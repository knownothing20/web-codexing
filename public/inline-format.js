// Local links are path references, never file:// URLs or download requests.
export function inlineParts(text) {
  const pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\][ \t]*(?:\n[ \t]*)?\((?:<[^<>\r\n]+>|[^\s)]+)\))/g;
  const parts=[];let at=0;
  for(const match of text.matchAll(pattern)){
    if(match.index>at)parts.push({type:'text',text:text.slice(at,match.index)});
    const token=match[0];
    if(token.startsWith('`'))parts.push({type:'code',text:token.slice(1,-1)});
    else if(token.startsWith('**'))parts.push({type:'strong',text:token.slice(2,-2)});
    else {
      const [,label,destination]=/^\[([^\]]+)\]\s*\((.*)\)$/.exec(token);
      let path=destination.startsWith('<')?destination.slice(1,-1):destination;
      if(/^\/[A-Za-z]:[\\/]/.test(path))path=path.slice(1);
      if(/[\u0000-\u001f\u007f]/.test(path))parts.push({type:'text',text:label});
      else if(/^https?:\/\//i.test(path)){
        try{const url=new URL(path);parts.push({type:'link',text:label,url:url.href});}
        catch{parts.push({type:'text',text:label});}
      } else if(/^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/.test(path)){
        const name=path.split(/[\\/]/).filter(Boolean).at(-1)||label;
        const extension=/\.([a-z0-9]{1,8})(?::\d+(?::\d+)?)?$/i.exec(name)?.[1].toUpperCase()||'文件';
        parts.push({type:'file',text:label,path,name,extension});
      } else parts.push({type:'text',text:label});
    }
    at=match.index+token.length;
  }
  if(at<text.length)parts.push({type:'text',text:text.slice(at)});
  return parts;
}
