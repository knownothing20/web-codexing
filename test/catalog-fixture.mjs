import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// An isolated stdio model directory. No login, network or inference is used.
export function catalogFixture(dir) {
  const models=[{model:'demo-fast',displayName:'Demo Fast',description:'隔离测试模型',hidden:false,
    supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',
    serviceTiers:[{id:'priority',name:'Fast',description:'测试加速档位'}],defaultServiceTier:null},
    {model:'demo-standard',displayName:'Demo Standard',description:'不支持加速的隔离模型',hidden:false,
    supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',serviceTiers:[],defaultServiceTier:null}];
  const file=join(dir,'model-directory.mjs');
  writeFileSync(file,`import {basename,join} from 'node:path';import {createInterface} from 'node:readline';import {mkdirSync,writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
if(basename(process.argv[1]||'')==='app-server'){
 if(process.argv.includes('generate-json-schema')){const dir=join(process.argv[process.argv.indexOf('--out')+1],'v2');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'ThreadForkParams.json'),JSON.stringify({properties:{lastTurnId:{},excludeTurns:{}}}));process.exit(0);}
 const models=${JSON.stringify(models)};const rl=createInterface({input:process.stdin});
 rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
 let response=m.method==='initialize'?{result:{}}:m.method==='model/list'?{result:{data:models,nextCursor:null}}:{error:{code:-32601,message:'Unsupported fixture method'}};
 if(m.method==='thread/fork'){
  const id=randomUUID(),db=new DatabaseSync(join(process.env.CODEX_HOME,'state_5.sqlite')),h=new DatabaseSync(join(process.env.CODEX_HOME,'thread_history_1.sqlite'));
  const parent=db.prepare('SELECT * FROM threads WHERE id=?').get(m.params.threadId);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'截图上传测试 · 分支','截图上传测试 · 分支',parent.cwd,Math.floor(Date.now()/1000),'test',0,null,'vscode','');db.close();
  const boundary=h.prepare('SELECT MAX(rollout_ordinal) AS n FROM thread_items WHERE thread_id=? AND turn_id=?').get(m.params.threadId,m.params.lastTurnId).n;
  h.prepare('INSERT INTO thread_items SELECT ?,turn_id,rollout_ordinal,item_id,item_type,item_json,created_at_ms FROM thread_items WHERE thread_id=? AND rollout_ordinal<=?').run(id,m.params.threadId,boundary);h.prepare('INSERT INTO thread_turns SELECT ?,turn_id,rollout_ordinal,status FROM thread_turns WHERE thread_id=? AND rollout_ordinal<=?').run(id,m.params.threadId,boundary);h.close();
  writeFileSync(join(process.env.CODEX_HOME,'fork-receipt.json'),JSON.stringify({threadId:m.params.threadId,lastTurnId:m.params.lastTurnId,id}));response={result:{thread:{id}}};
 }
 process.stdout.write(JSON.stringify({id:m.id,...response})+'\\n');});
 await new Promise(resolve=>process.stdin.once('end',resolve));rl.close();
}
`);
  return {REMOTE_CODING_CODEX:process.execPath,NODE_OPTIONS:'--import '+pathToFileURL(file).href};
}
