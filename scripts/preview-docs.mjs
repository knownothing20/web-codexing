// Loopback-only renderer for the public README artwork. No account or Codex access.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if (['/hero','/features','/connection'].includes(path)) {
    const html=readFileSync(join(root,'docs','visuals','overview.html'),'utf8').replace('<body data-scene="hero">',`<body data-scene="${path.slice(1)}">`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
  }
  if(['/mobile.png','/question.png'].includes(path)) {res.writeHead(200,{'Content-Type':'image/png'});res.end(readFileSync(join(root,'docs','previews',path.slice(1))));return;}
  res.writeHead(404);res.end();
});
server.listen(35551,'127.0.0.1',()=>console.log('README artwork preview: http://127.0.0.1:35551/hero'));
