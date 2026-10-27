// Disposable UI acceptance environment. No real Codex or provider task is submitted.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { FrameReader, frame } from '../src/ipc.mjs';
import {catalogFixture} from './catalog-fixture.mjs';

const base = resolve('.local'); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, 'ui-test-')), id = randomUUID(), pipe = '\\\\.\\pipe\\remote-coding-ui-' + randomUUID();
const historicalMode=process.argv.includes('--history-notifications');
const noticeMode=process.argv.includes('--notifications')||historicalMode;
const recentMode=process.argv.includes('--recent');
const specialMode=process.argv.includes('--special');
const statusMode=process.argv.includes('--status')||noticeMode||recentMode||specialMode,otherId=randomUUID(),unloadedId=randomUUID();let missingLoaded=false;
const manyMode=process.argv.includes('--many'),manyIds=new Set();
const mediaDetailsMode=process.argv.includes('--media-details');
const generatedMode=process.argv.includes('--generated');
const fileLinksMode=process.argv.includes('--file-links');
const mediaMode=process.argv.includes('--media')||mediaDetailsMode;
const actionsMode=process.argv.includes('--actions');
const settingsMode=process.argv.includes('--settings')||mediaMode||actionsMode||specialMode||generatedMode||fileLinksMode;
let ownerReads=0,fullFollows=0,starts=0,steers=0,stops=0;const checkedIds=new Set();
const metrics=()=>{if(manyMode||fileLinksMode)writeFileSync(join(fixture,'metrics.json'),JSON.stringify({ownerReads,uniqueOwnerReads:checkedIds.size,fullFollows,starts,steers,stops}));};
const db = new DatabaseSync(join(fixture, 'state_5.sqlite'));
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,model TEXT,archived INTEGER,agent_path TEXT,source TEXT,rollout_path TEXT)');
db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '手机问答验收 · 隔离测试', '手机问答验收 · 隔离测试', resolve('.'), Math.floor(Date.now()/1000), 'test', 0, null, 'vscode', '');
if(statusMode)db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(otherId,'另一个会话 · 隔离测试','另一个会话 · 隔离测试',resolve('.'),Math.floor(Date.now()/1000)+5,'test',0,null,'vscode','');
if(statusMode)db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(unloadedId,'尚未打开 · 隔离测试','尚未打开 · 隔离测试',resolve('.'),Math.floor(Date.now()/1000)-5,'test',0,null,'vscode','');
if(recentMode)db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(Math.floor(Date.now()/1000)-8*86400,otherId);
if(manyMode)for(let i=0;i<40;i++){const next=randomUUID();manyIds.add(next);db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(next,'列表性能测试 '+String(i+1).padStart(2,'0'),'列表性能测试',resolve('.'),Math.floor(Date.now()/1000)-10-i,'test',0,null,'vscode','');}
db.close();
const history = new DatabaseSync(join(fixture, 'thread_history_1.sqlite'));
history.exec('CREATE TABLE thread_items (thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER)');
history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id, 'turn', 1, 'u', 'userMessage', JSON.stringify({ id:'u', type:'userMessage', content:[{type:'text',text:'这是隔离验收会话，不会运行真实任务。'}] }), Date.now()); history.close();
if(statusMode){const d=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));d.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT)');d.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(id,'turn',1,'interrupted');d.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(otherId,'other-turn',1,'completed');d.close();}
const state = { id, title: '手机问答验收 · 隔离测试', latestModel: 'test', threadRuntimeStatus: {type:'active'},
  requests: [{id:'form',method:'item/tool/requestUserInput',params:{questions:[
    {id:'choice',header:'阅读偏好',question:'选择进度的显示方式',isOther:true,isSecret:false,options:[{label:'全部展开',description:'直接阅读所有进度'},{label:'默认折叠',description:'需要时再展开'}]},
    {id:'text',header:'备注',question:'填写一条备注',isOther:true,isSecret:false,options:null},
  ]}}], turns:[{turnId:'turn',turnStartedAtMs:Date.now(),status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'请测试选择和填写表单。'}]}, {id:'a',type:'agentMessage',phase:'commentary',text:'请选择一个选项并填写备注；测试只回传答案。'}]}] };
const sockets = new Set(); let revision = 1, online = true;
const otherState={id:otherId,title:'另一个会话 · 隔离测试',threadRuntimeStatus:{type:'idle'},requests:[],turns:[{turnId:'other-turn',status:'completed',items:[{id:'other-message',type:'agentMessage',text:'这是一条独立的演示会话，用来验证未打开会话的列表状态。'}]}]};
const unloadedState={...otherState,id:unloadedId,title:'尚未打开 · 隔离测试'};
const requestTemplate=structuredClone(state.requests);
if(settingsMode){state.latestModel='demo-fast';state.latestReasoningEffort='high';state.latestThreadSettings={model:'demo-fast',serviceTier:'priority'};state.requests=[];state.threadRuntimeStatus={type:'idle'};state.turns[0].status='completed';}
if(specialMode){
  state.title='转发消息与定时任务 · 手机预览';
  const text='请帮我核对项目的恢复进度，并保留当前环境。\n\n'+['保留原端口与数据。','逐项提供可核对的结果。','只读检查，不启动付费调用。','需要操作时先在原会话确认。'].join('\n')+'\n\n这是一条来自其他会话的长消息，用于检查手机上的全文展开、来源跳转和草稿保留。'.repeat(4);
  state.turns[0].items=[{id:'forward-demo',type:'functionCallOutput',name:'send_message_to_thread',namespace:'codex_app',output:`<codex_delegation>\n<source_thread_id>${otherId}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`},
    {id:'special-reply',type:'agentMessage',text:'已收到来自另一条会话的协调消息。检查结果会继续显示在这里。'},
    {id:'automation-demo',type:'mcpToolCall',server:'codex_app',tool:'automation_update',status:'completed',arguments:{mode:'create',name:'跟进项目恢复进度',rrule:'FREQ=MINUTELY;INTERVAL=5',status:'ACTIVE',prompt:'INTERNAL_TASK_PROMPT'},result:{content:[{type:'text',text:JSON.stringify({automationId:'demo-check',mode:'create',status:'ACTIVE'})}]}},
    {id:'private-tool',type:'commandExecution',aggregatedOutput:'INTERNAL_TOOL_OUTPUT'}];
  const s=new DatabaseSync(join(fixture,'state_5.sqlite'));s.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(state.title,state.title,id);s.close();
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));h.prepare('DELETE FROM thread_items WHERE thread_id=?').run(id);h.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('completed',id);
  state.turns[0].items.forEach((item,i)=>h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id,'turn',i+1,item.id,item.type,JSON.stringify(item),Date.now()));h.close();
}
if(actionsMode){
  const {default:sharp}=await import('sharp');
  await sharp(Buffer.from('<svg width="900" height="550"><rect width="900" height="550" fill="#e9f0e6"/><text x="70" y="145" font-size="42" fill="#426b51">SCREENSHOT PREVIEW</text><text x="70" y="230" font-size="25" fill="#426b51">Paste on PC / Upload on phone</text></svg>')).png().toFile(join(fixture,'screenshot.png'));
  writeFileSync(join(fixture,'notes.txt'),'Synthetic document for local upload acceptance.');
  state.title='截图与文件 · 网页对话';state.turns=[{turnId:'turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'这段回复可以复制，也可以从这里继续分支吗？'}]},{id:'a',type:'agentMessage',phase:'final_answer',text:'可以。回复下方点「复制」保存内容，点「分支」从这里开始新的方向。\n\n电脑支持粘贴截图，手机可以通过输入框旁的「＋」选择图片和文件。'}]},{turnId:'later',status:'completed',items:[{id:'later-u',type:'userMessage',content:[{type:'text',text:'这条是后续消息，前一条回复的分支不应包含它。'}]},{id:'later-a',type:'agentMessage',text:'已了解。这条后续回复用来核对分支位置。'}]}];
  const d=new DatabaseSync(join(fixture,'state_5.sqlite'));d.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(state.title,state.title,id);d.close();
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));h.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT)');h.prepare('DELETE FROM thread_items WHERE thread_id=?').run(id);
  let order=0;for(const turn of state.turns){h.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(id,turn.turnId,++order,'completed');for(const item of turn.items)h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id,turn.turnId,++order,item.id,item.type,JSON.stringify(item),Date.now());}h.close();
}
if(mediaMode){
  const {default:sharp}=await import('sharp');
  const photos=[];
  for(const [i,color] of ['#547b63','#ae7851'].entries()){
    const path=join(fixture,`photo-${i+1}.jpg`);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="${color}"/><circle cx="1230" cy="260" r="130" fill="#f4dfae"/><path d="M0 820 410 320 860 820 1180 510 1600 920V1000H0" fill="#1e3a34"/><text x="90" y="145" font-family="sans-serif" font-size="44" fill="white">MOBILE PREVIEW / 0${i+1}</text><text x="90" y="930" font-family="sans-serif" font-size="92" fill="white">${i===0?'MOUNTAINS':'SUNSET'}</text></svg>`;
    await sharp(Buffer.from(svg)).jpeg({quality:92}).toFile(path);photos.push(path);
  }
  const clip=join(fixture,'preview.mp4');
  // Only this optional developer fixture needs ffmpeg; the shipped server never transcodes.
  execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',clip],{windowsHide:true,stdio:'ignore'});
  state.title='图片与视频 · 手机预览';state.turns[0].items=[
    {id:'u',type:'userMessage',content:[{type:'text',text:'这两张图片和演示视频，手机上能直接查看吗？'}]},
    {id:'media-answer',type:'agentMessage',phase:'final_answer',text:`可以。图片点开放大，左右切换；视频点击后才加载播放。\n\n![山景](${photos[0]})\n![日落](${photos[1]})\n[演示视频](${clip})\n\n文件留在电脑，手机按需查看。`}
  ];
  if(mediaDetailsMode)state.turns[0].items[1].text=`这次图片放在对应的折叠预览里，点击下面的按钮查看。\n\n<details>\n<summary>手机预览图</summary>\n\n![山景](${photos[0]})\n![日落](${photos[1]})\n[演示视频](${clip})\n\n</details>\n\n这里是预览块之后的说明。`;
  const d=new DatabaseSync(join(fixture,'state_5.sqlite'));d.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(state.title,state.title,id);d.close();
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id,'turn',2,'media-answer','agentMessage',JSON.stringify(state.turns[0].items[1]),Date.now());h.close();
}
if(generatedMode){
  const {default:sharp}=await import('sharp');
  state.title='生成图片 · 手机预览';state.requests=[];state.threadRuntimeStatus={type:'idle'};state.turns[0].status='completed';
  state.turns[0].items=[{id:'generated-user',type:'userMessage',content:[{type:'text',text:'这四张生成图，手机上能直接看吗？'}]}];
  const colors=['#294a46','#b38356','#809a86','#a9b69d'];
  for(let i=0;i<4;i++){
    const savedPath=join(fixture,`generated-${i+1}.png`);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${colors[i]}"/><circle cx="735" cy="115" r="55" fill="#f8d78c"/><path d="M0 470L270 150L530 435L740 250L960 490V540H0Z" fill="#183f37"/><path d="M0 500L360 355L650 495L960 390V540H0Z" fill="#48705d"/><text x="50" y="80" font-family="sans-serif" font-size="35" fill="white">SCENE 0${i+1}</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(savedPath);
    state.turns[0].items.push({id:`native-image-${i}`,type:'imageGeneration',status:'completed',savedPath,revisedPrompt:'PRIVATE_FIXTURE_PROMPT',result:'PRIVATE_FIXTURE_RESULT',failure:null});
  }
  state.turns[0].items.push({id:'generated-answer',type:'agentMessage',phase:'final_answer',text:'四张图片已生成。下面按顺序预览，点开可以放大、切换和保存原图。'});
  const d=new DatabaseSync(join(fixture,'state_5.sqlite'));d.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(state.title,state.title,id);d.close();
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));
  h.prepare('DELETE FROM thread_items WHERE thread_id=?').run(id);
  for(const [i,item] of state.turns[0].items.entries())h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id,'turn',i+1,item.id,item.type,JSON.stringify(item),Date.now());
  h.close();
}
if(fileLinksMode){
  state.title='文件与输入框 · 手机预览';state.threadRuntimeStatus={type:'active'};state.turns[0].status='inProgress';
  state.turns[0].items=[{id:'files-user',type:'userMessage',content:[{type:'text',text:'这几个文件，整理成方便手机阅读的样式。'}]},
    {id:'files-answer',type:'agentMessage',phase:'final_answer',text:'已整理审核材料，原文件保留。\n\n[审核包（NAS，27.7 MB）](</srv/example/projects/demo/reviews/weekly-review/archive-v2.zip>)\n\n两份工作流都还在：\n\n- [快速版](</D:/Example Workflows/版本目录/中文 快速版.json>)\n- [质量版]\n(</D:/Example Workflows/版本目录/中文 (质量版).json>)\n\n文件路径默认收起，点开可以查看和复制。'}];
  const d=new DatabaseSync(join(fixture,'state_5.sqlite'));d.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(state.title,state.title,id);d.close();
}
if(statusMode){state.threadRuntimeStatus={type:'idle'};state.turns[0].status='interrupted';}
if(noticeMode){
  state.title='正在编写的会话';state.requests=[];state.turns[0].status='inProgress';state.threadRuntimeStatus={type:'active'};
  otherState.title='旅行手册 · 演示任务';otherState.turns[0].status='inProgress';otherState.threadRuntimeStatus={type:'active'};
  const d=new DatabaseSync(join(fixture,'state_5.sqlite'));
  d.prepare('UPDATE threads SET name=?,title=?,updated_at=? WHERE id=?').run(state.title,state.title,Math.floor(Date.now()/1000)+10,id);
  d.prepare('UPDATE threads SET name=?,title=? WHERE id=?').run(otherState.title,otherState.title,otherId);d.close();
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));h.prepare('UPDATE thread_turns SET status=?').run('inProgress');h.close();
}
if(historicalMode){
  otherState.threadRuntimeStatus={type:'idle'};
  otherState.turns=[{turnId:'old-question-turn',status:'completed',items:[{id:'old-question',type:'agentMessage',text:'这是很久以前的问题，只保留手动补答入口。',questions:[{title:'这是很久以前的问题，不应再提醒',options:['历史选项']}]}]},
    {turnId:'other-turn',status:'completed',items:[{id:'later-result',type:'agentMessage',phase:'final_answer',text:'后续任务已经完成，旧问题只供手动查看和补答。'}]}];
  const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));
  h.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('completed',otherId);
  h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(otherId,'old-question-turn',1,'old-question','agentMessage',JSON.stringify(otherState.turns[0].items[0]),Date.now()-86400000*10);
  h.close();
}
const broadcast = (socket,conversationId=id) => socket.write(frame({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'fixture-owner',params:{conversationId,hostId:'local',change:{type:'snapshot',revision:revision++,conversationState:conversationId===unloadedId?unloadedState:conversationId===otherId?otherState:state}}}));
const fake = net.createServer(socket => {
  if (!online) {socket.destroy();return;} sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
  const reader = new FrameReader(message=>{
    if (message.type==='request') {
      if(message.method==='thread-owner-discovery'){ownerReads++;checkedIds.add(message.params.conversationId);metrics();}
      if(actionsMode&&message.method==='thread-owner-discovery'&&message.params.conversationId!==id){socket.write(frame({type:'response',requestId:message.requestId,resultType:'error',error:'no-client-found'}));return;}
      if(message.method==='thread-owner-discovery'&&(message.params.conversationId===unloadedId&&!missingLoaded||manyIds.has(message.params.conversationId))){socket.write(frame({type:'response',requestId:message.requestId,resultType:'error',error:'no-client-found'}));return;}
      let result={}; if(message.method==='initialize')result={clientId:'fixture-client'};
      if(message.method==='thread-follower-update-thread-settings') {
        Object.assign(state.latestThreadSettings,message.params.threadSettings);state.latestModel=message.params.threadSettings.model;state.latestReasoningEffort=message.params.threadSettings.effort;
        writeFileSync(join(fixture,'settings-receipt.json'),JSON.stringify(message.params));result={applied:true};setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      if(message.method==='thread-follower-read-model-settings')result={settings:{model:state.latestModel,reasoningEffort:state.latestReasoningEffort}};
      if(message.method==='thread-follower-submit-user-input') {
        const target=message.params.conversationId===otherId?otherState:state;
        writeFileSync(join(fixture,'receipt.json'),JSON.stringify(message.params.response));
        target.requests=[]; target.threadRuntimeStatus={type:'idle'}; target.turns[0].status='completed';
        if(statusMode){const d=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));d.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('completed',target.id);d.close();}
        target.turns[0].items.push({id:'receipt',type:'agentMessage',phase:'final_answer',text:'已收到答案：'+Object.values(message.params.response.answers).flatMap(a=>a.answers).join(' · ')});
        setTimeout(()=>{for(const s of sockets)broadcast(s,target.id);},80);
      }
      if(message.method==='thread-follower-steer-turn') {
        steers++;metrics();
        writeFileSync(join(fixture,'steer-receipt.json'),JSON.stringify(message.params));
        const target=fileLinksMode?state.turns.at(-1):state.turns[0];
        target.items.push({id:'steer',type:'steeringUserMessage',status:'accepted',input:message.params.input});
        result={result:{turnId:target.turnId}};
        setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      if(message.method==='thread-follower-start-turn') {
        starts++;metrics();
        if(message.params.turnStart.context.useUserMessageAdmission)throw new Error('Cloud admission must stay disabled');
        writeFileSync(join(fixture,'history-reply-receipt.json'),JSON.stringify(message.params));
        const turnId=fileLinksMode?'reply-'+randomUUID():'history-reply';
        state.turns.push({turnId,status:actionsMode?'completed':'inProgress',items:[{id:fileLinksMode?message.params.turnStart.request.clientUserMessageId:'history-answer',type:'userMessage',content:message.params.turnStart.request.input},...actionsMode?[{id:'upload-answer',type:'agentMessage',phase:'final_answer',text:'已收到图片和文件（隔离测试回执，没有运行真实任务）。'}]:[]]});
        if(fileLinksMode)result={result:{turn:{id:turnId}}};
        state.threadRuntimeStatus={type:actionsMode?'idle':'active'};
        setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      if(fileLinksMode&&message.method==='thread-follower-interrupt-turn'){
        stops++;metrics();state.threadRuntimeStatus={type:'idle'};state.turns.at(-1).status='interrupted';setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      socket.write(frame({type:'response',requestId:message.requestId,method:message.method,handledByClientId:'fixture-owner',resultType:'success',result}));
    } else if(message.method==='thread-stream-following-changed' && message.params.following){fullFollows++;metrics();broadcast(socket,message.params.conversationId);}
  }); socket.on('data',data=>reader.push(data));
});
await new Promise(resolve=>fake.listen(pipe,resolve));
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','src/server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,...settingsMode?catalogFixture(fixture):{},CODEX_HOME:fixture,REMOTE_CODING_RUNTIME_DIR:fixture,REMOTE_CODING_IPC_PIPE:pipe,REMOTE_CODING_PORT:'35470',REMOTE_CODING_WORKBUDDY_ACCESS_TOKEN:'',REMOTE_CODING_DISABLE_DESKTOP_OPEN:'1',REMOTE_CODING_DISABLE_ACCOUNT_QUOTA:'1'},stdio:'ignore'});
const runtimeFile=join(fixture,'runtime.json');
for(let tries=0;tries<100&&!existsSync(runtimeFile);tries++)await new Promise(resolve=>setTimeout(resolve,50));
const runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));
console.log(JSON.stringify({url:`http://127.0.0.1:${runtime.port}/`,pairCode:runtime.pairCode,fixture,threadId:id}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;const exited=child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();child.kill();for(const s of sockets)s.destroy();await exited; await new Promise(resolve=>fake.close(resolve));if(!resolve(fixture).startsWith(base+'\\'))throw new Error('unsafe fixture cleanup');rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:50});process.exit(0);}
const command = line => {
  if(specialMode&&line.trim()==='special-update'){
    const task=state.turns[0].items.find(i=>i.id==='automation-demo');task.arguments.status='PAUSED';task.result.content[0].text=JSON.stringify({automationId:'demo-check',status:'PAUSED'});
    for(const socket of sockets)broadcast(socket);
  }
  if(mediaMode&&line.trim()==='media-error'){
    const path=join(fixture,'unsupported.mp4');writeFileSync(path,Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(128)]));
    state.turns[0].items.push({id:'bad-media',type:'agentMessage',phase:'final_answer',text:`[格式测试视频](${path})`});
    for(const socket of sockets)broadcast(socket);
  }
  if(line.trim()==='notice-waiting'||line.trim()==='notice-complete'){
    const waiting=line.trim()==='notice-waiting';
    otherState.requests=waiting?structuredClone(requestTemplate):[];
    if(!waiting)otherState.turns[0].turnId=randomUUID();
    otherState.turns[0].status=waiting?'interrupted':'completed';otherState.threadRuntimeStatus={type:'idle'};
    const h=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));
    h.prepare('UPDATE thread_turns SET status=?,turn_id=?,rollout_ordinal=rollout_ordinal+1 WHERE thread_id=?').run(waiting?'interrupted':'completed',otherState.turns[0].turnId,otherId);
    h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(otherId,'other-turn',Date.now(),randomUUID(),'agentMessage',JSON.stringify({type:'agentMessage',text:'状态变更 · 隔离测试'}),Date.now());h.close();
    for(const s of sockets)broadcast(s,otherId);
  }
  if(line.trim()==='offline'){online=false;for(const s of sockets)s.destroy();console.log('Fixture desktop is offline');}
  if(line.trim()==='async'){
    state.requests=[];state.threadRuntimeStatus={type:'active'};state.turns[0].status='inProgress';
    state.turns[0].items.push({id:'async-question',type:'agentMessage',phase:'final_answer',text:'请选择一个选项，测试回答入口。',questions:[{title:'手机选择测试',options:['选项一','选项二']}]});
    for(const s of sockets)broadcast(s);
  }
  if(line.trim()==='complete'){
    state.requests=[];state.threadRuntimeStatus={type:'idle'};state.turns.at(-1).status='completed';
    state.turns.at(-1).items.push({id:'completed',type:'agentMessage',phase:'final_answer',text:'任务已完成。这是隔离测试的完成结果。'});
    for(const s of sockets)broadcast(s);
  }
  if(line.trim()==='new-complete'){
    state.requests=[];state.threadRuntimeStatus={type:'idle'};
    state.turns.push({turnId:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'新一轮任务已完成，蓝点应重新出现。'}]});
    for(const s of sockets)broadcast(s);
  }
  if(line.trim()==='quit')stop();
  if(line.trim()==='load-missing')missingLoaded=true;
  if(line.trim()==='desktop-fast-off'||line.trim()==='desktop-fast-on'){state.latestThreadSettings.serviceTier=line.trim()==='desktop-fast-on'?'priority':'default';for(const s of sockets)broadcast(s);}
  if(line.trim()==='stop-question'){
    state.requests=structuredClone(requestTemplate);state.requests[0].id=randomUUID();state.threadRuntimeStatus={type:'idle'};state.turns[0].status='interrupted';
    if(statusMode){const d=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));d.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('interrupted',id);d.close();}
    for(const s of sockets)broadcast(s);
  }
};
const rl=createInterface({input:process.stdin});rl.on('line',command);
setInterval(()=>{const path=join(fixture,'control.txt');if(existsSync(path)){const line=readFileSync(path,'utf8');rmSync(path);command(line);}},300);
setTimeout(stop,20*60000);process.on('SIGTERM',stop);process.on('SIGINT',stop);
