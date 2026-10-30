// Public screenshots use this isolated server, never a real account or Codex process.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Date.now();
const threads = [
  { id:'demo-chat', title:'优化移动端阅读体验', project:'web-codexing', status:'running', updatedAt:now },
  { id:'demo-question', title:'选择下一步开发方向', project:'web-codexing', status:'waiting', updatedAt:now-60000 },
  { id:'demo-complete', title:'整理项目文档', project:'web-codexing', status:'idle', completionKey:'demo-result', updatedAt:now-3600000 },
];
const m = (id, role, text, extra = {}) => ({ id, role, text, at:now-120000, timeSource:'recorded', turnId:'demo-turn', ...extra });
const messages = [
  m('demo-user','user','帮我优化手机上的对话体验，查看进度和补充要求都方便一点。'),
  m('demo-progress','assistant','已经检查手机布局，接下来会调整进度折叠和输入框的交互。',{phase:'commentary'}),
  m('demo-answer','assistant','这轮界面已调整：\n\n- **进度按需展开**，也可以一键展开某条消息之后的进度。\n- **回到最新消息**，阅读历史时不用反复滑动。\n- **执行中追加引导**，补充要求会交给原来的任务。\n\n下一步正在检查手机上的阅读体验。',{phase:'final_answer'}),
  m('demo-guidance','user','手机上优先保证文字好读，输入框保持在底部。',{guidance:true,at:now-60000}),
  m('demo-progress-2','assistant','收到，正在检查窄屏下的阅读宽度和输入框位置。',{phase:'commentary',at:now-30000}),
];
const questions = [{ id:'demo-request', method:'item/tool/requestUserInput', questions:[{id:'direction',question:'下一步优先完善哪一项？',isOther:true,options:[
  {label:'对话阅读体验',description:'先完善折叠、时间和回到最新消息'},
  {label:'技能与会话引用',description:'让补充上下文更方便'},
  {label:'图片预览',description:'查看缩略图和原图'},
]}] }];

export function createDemoServer({credits=false}={}) {
  const streams = new Set();
  const activeThreads = new Map();
  const demoThreads = structuredClone(threads);
  const activity = () => ({type:'activity',threads:demoThreads.map(t=>({...t,pendingKey:t.status==='waiting'?(t.pendingKey || 'demo-question'):null,pendingVerified:t.status==='waiting',availability:'ready'})),removedIds:[]});
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    const json = value => {res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const assets = {'/':'index.html','/app.js':'app.js','/clipboard.js':'clipboard.js','/inline-format.js':'inline-format.js','/outbox.js':'outbox.js','/read-state.js':'read-state.js','/service-tier.js':'service-tier.js','/notifications.js':'notifications.js','/style.css':'style.css','/icon.svg':'icon.svg','/manifest.webmanifest':'manifest.webmanifest'};
    if (req.method === 'GET' && assets[url.pathname]) {
      let content = readFileSync(join(root,'public',assets[url.pathname]));
      if(url.pathname==='/') content=Buffer.from(content.toString().replaceAll('Remote Coding','Web Codexing').replace('你的 Codex，随身连接','公开演示 · 不连接真实账号').replace('局域网直连','演示模式 · 无真实任务'));
      const type = url.pathname==='/'?'text/html':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.svg')?'image/svg+xml':'application/json';
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(content);return;
    }
    if(url.pathname==='/overview') {
      const scene=['hero','features','connection','notifications'].includes(url.searchParams.get('scene'))?url.searchParams.get('scene'):'hero';
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(join(root,'docs/visuals/overview.html'),'utf8').replace('body data-scene="hero"',`body data-scene="${scene}"`));return;
    }
    if(/^\/(mobile|question|notification|notifications-list|model-settings)\.png$/.test(url.pathname)) {
      res.writeHead(200,{'Content-Type':'image/png'});res.end(readFileSync(join(root,'docs/previews',url.pathname.slice(1))));return;
    }
    if(req.method==='POST') { res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'演示模式：不会提交真实任务或设置。'}));return; }
    if(url.pathname==='/api/status') return json({csrf:'demo-only',computer:'演示电脑 · DEMO',connected:true,features:{openDesktop:false}});
    if(url.pathname==='/api/providers') return json({providers:[{id:'codex',name:'Codex',connected:true}]});
    if(url.pathname==='/api/quota') return json({buckets:[{name:'演示额度',plan:null,credits:credits?{hasCredits:true,unlimited:false,balance:12345.67}:null,windows:[{kind:'primary',minutes:credits?10080:300,remaining:credits?0:80,resetsAt:now+7200000}]}],updatedAt:now,stale:false});
    if(url.pathname==='/api/threads') return json({threads:demoThreads.filter(t=>t.title.includes(url.searchParams.get('q')||'')),next:null});
    if(url.pathname==='/api/models') return json({models:[{id:'Codex · Demo',description:'仅演示界面，不代表真实模型可用性',efforts:['low','medium','high'],defaultEffort:'high',serviceTiers:[{id:'priority',name:'Fast'}],defaultServiceTier:null}]});
    const match = /^\/api\/threads\/(demo-chat|demo-question|demo-complete)\/(history|events|skills)$/.exec(url.pathname);
    if(match) {
      const [,id,action]=match, thread=demoThreads.find(t=>t.id===id);
      const items = id==='demo-question' ? [m('demo-q-user','user','我们先确定下一步的开发方向。'),m('demo-q-agent','assistant','可以，请选择优先级。这是演示问题，不会运行实际任务。',{phase:'commentary'})] : id==='demo-complete' ? [m('demo-done','assistant','项目说明与使用文档已整理完成。',{phase:'final_answer'})] : messages;
      if(action==='skills') return json({skills:[{id:'demo-skill',name:'界面检查',description:'演示用技能条目，不连接本机技能目录'}],warnings:0});
      if(action==='history') return json({messages:items,cursor:null});
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});
      res.write(`data: ${JSON.stringify({...activity(),initial:true})}\n\n`);
      res.write(`data: ${JSON.stringify({type:'snapshot',connected:true,writable:true,busy:thread.status==='running',status:thread.status,title:thread.title,model:'Codex · Demo',effort:'high',serviceTier:'priority',serviceTierKnown:true,messages:items,order:items.map(m=>m.id),turnIds:['demo-turn'],requests:thread.status==='waiting'?questions:[],completionKey:thread.completionKey})}\n\n`);
      streams.add(res);activeThreads.set(res,id); const timer=setInterval(()=>res.write(': demo\n\n'),20000); req.on('close',()=>{clearInterval(timer);streams.delete(res);activeThreads.delete(res);});return;
    }
    res.writeHead(404);res.end('Demo route not found');
  });
  // Local test/preview hook only: no HTTP action endpoint and no real account.
  server.updateDemo = (id,patch) => {
    const thread=demoThreads.find(t=>t.id===id);if(!thread)throw new Error('Unknown demo chat');
    Object.assign(thread,patch);
    for(const stream of streams)stream.write(`data: ${JSON.stringify(activity())}\n\n`);
  };
  server.stopDemo = () => { for(const stream of streams)stream.end(); server.closeAllConnections(); return new Promise(done=>server.close(done)); };
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const server=createDemoServer({credits:process.argv.includes('--credits')});
  server.listen(35550,'127.0.0.1',()=>console.log('Public demo only: http://127.0.0.1:35550/ — no Codex, no account access. Ctrl+C to stop.'));
  process.on('SIGINT',()=>server.stopDemo().then(()=>process.exit(0)));
}
