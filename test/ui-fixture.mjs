// Disposable UI acceptance environment. No real Codex or provider task is submitted.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { FrameReader, frame } from '../src/ipc.mjs';

const base = resolve('.local'); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, 'ui-test-')), id = randomUUID(), pipe = '\\\\.\\pipe\\remote-coding-ui-' + randomUUID();
const statusMode=process.argv.includes('--status'),otherId=randomUUID();
const db = new DatabaseSync(join(fixture, 'state_5.sqlite'));
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,model TEXT,archived INTEGER,agent_path TEXT,source TEXT,rollout_path TEXT)');
db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '手机问答验收 · 隔离测试', '手机问答验收 · 隔离测试', resolve('.'), Math.floor(Date.now()/1000), 'test', 0, null, 'vscode', '');
if(statusMode)db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(otherId,'另一个会话 · 隔离测试','另一个会话 · 隔离测试',resolve('.'),Math.floor(Date.now()/1000)+5,'test',0,null,'vscode','');
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
const requestTemplate=structuredClone(state.requests);
if(statusMode){state.threadRuntimeStatus={type:'idle'};state.turns[0].status='interrupted';}
const broadcast = (socket,conversationId=id) => socket.write(frame({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'fixture-owner',params:{conversationId,hostId:'local',change:{type:'snapshot',revision:revision++,conversationState:conversationId===otherId?otherState:state}}}));
const fake = net.createServer(socket => {
  if (!online) {socket.destroy();return;} sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
  const reader = new FrameReader(message=>{
    if (message.type==='request') {
      let result={}; if(message.method==='initialize')result={clientId:'fixture-client'};
      if(message.method==='thread-follower-submit-user-input') {
        writeFileSync(join(fixture,'receipt.json'),JSON.stringify(message.params.response));
        state.requests=[]; state.threadRuntimeStatus={type:'idle'}; state.turns[0].status='completed';
        if(statusMode){const d=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));d.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('completed',id);d.close();}
        state.turns[0].items.push({id:'receipt',type:'agentMessage',phase:'final_answer',text:'已收到答案：'+Object.values(message.params.response.answers).flatMap(a=>a.answers).join(' · ')});
        setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      if(message.method==='thread-follower-steer-turn') {
        writeFileSync(join(fixture,'steer-receipt.json'),JSON.stringify(message.params));
        state.turns[0].items.push({id:'steer',type:'steeringUserMessage',status:'accepted',input:message.params.input});
        result={result:{turnId:state.turns[0].turnId}};
        setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      if(message.method==='thread-follower-start-turn') {
        if(message.params.turnStart.context.useUserMessageAdmission)throw new Error('Cloud admission must stay disabled');
        writeFileSync(join(fixture,'history-reply-receipt.json'),JSON.stringify(message.params));
        state.turns.push({turnId:'history-reply',status:'inProgress',items:[{id:'history-answer',type:'userMessage',content:message.params.turnStart.request.input}]});
        state.threadRuntimeStatus={type:'active'};
        setTimeout(()=>{for(const s of sockets)broadcast(s);},80);
      }
      socket.write(frame({type:'response',requestId:message.requestId,method:message.method,handledByClientId:'fixture-owner',resultType:'success',result}));
    } else if(message.method==='thread-stream-following-changed' && message.params.following)broadcast(socket,message.params.conversationId);
  }); socket.on('data',data=>reader.push(data));
});
await new Promise(resolve=>fake.listen(pipe,resolve));
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','src/server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,CODEX_HOME:fixture,REMOTE_CODING_RUNTIME_DIR:fixture,REMOTE_CODING_IPC_PIPE:pipe,REMOTE_CODING_PORT:'35470',REMOTE_CODING_WORKBUDDY_ACCESS_TOKEN:'',REMOTE_CODING_DISABLE_DESKTOP_OPEN:'1',REMOTE_CODING_DISABLE_ACCOUNT_QUOTA:'1'},stdio:'ignore'});
const runtimeFile=join(fixture,'runtime.json');
for(let tries=0;tries<100&&!existsSync(runtimeFile);tries++)await new Promise(resolve=>setTimeout(resolve,50));
const runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));
console.log(JSON.stringify({url:`http://127.0.0.1:${runtime.port}/`,pairCode:runtime.pairCode,fixture,threadId:id}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;const exited=child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();child.kill();for(const s of sockets)s.destroy();await exited; await new Promise(resolve=>fake.close(resolve));if(!resolve(fixture).startsWith(base+'\\'))throw new Error('unsafe fixture cleanup');rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:50});process.exit(0);}
const command = line => {
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
  if(line.trim()==='stop-question'){
    state.requests=structuredClone(requestTemplate);state.requests[0].id=randomUUID();state.threadRuntimeStatus={type:'idle'};state.turns[0].status='interrupted';
    if(statusMode){const d=new DatabaseSync(join(fixture,'thread_history_1.sqlite'));d.prepare('UPDATE thread_turns SET status=? WHERE thread_id=?').run('interrupted',id);d.close();}
    for(const s of sockets)broadcast(s);
  }
};
const rl=createInterface({input:process.stdin});rl.on('line',command);
setInterval(()=>{const path=join(fixture,'control.txt');if(existsSync(path)){const line=readFileSync(path,'utf8');rmSync(path);command(line);}},300);
setTimeout(stop,20*60000);process.on('SIGTERM',stop);process.on('SIGINT',stop);
