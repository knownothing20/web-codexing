import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {messageFromItem,messagesFromTurns} from '../src/state.mjs';
import {scheduleLabel} from '../src/special-items.mjs';
import {Catalog} from '../src/catalog.mjs';

const source=randomUUID();
const forwarded=(id='forward')=>({id,type:'functionCallOutput',name:'send_message_to_thread',namespace:'codex_app',
  output:`<codex_delegation>\n <source_thread_id>${source}</source_thread_id>\n <input>请核对这条协调消息。\n只查看现状。</input>\n</codex_delegation>`});
const automation=(id='task')=>({id,type:'mcpToolCall',server:'codex_app',tool:'automation_update',status:'completed',
  arguments:{mode:'create',name:'项目状态检查',kind:'heartbeat',rrule:'FREQ=MINUTELY;INTERVAL=5',status:'ACTIVE',prompt:'PRIVATE_TASK_PROMPT'},
  result:{content:[{type:'text',text:'Created automation in the app.'},{type:'text',text:JSON.stringify({automationId:'check-project',mode:'create',status:'ACTIVE'})}],_meta:{private:'PRIVATE_TOOL_METADATA'}}});

test('forwarded desktop messages expose only the envelope body and a validated source chat',()=>{
  const m=messageFromItem(forwarded(),'turn');
  assert.equal(m.kind,'forwarded');assert.equal(m.role,'user');assert.equal(m.turnId,'turn');
  assert.equal(m.text,'请核对这条协调消息。\n只查看现状。');assert.equal(m.forwarded.threadId,source);
  assert.equal(JSON.stringify(m).includes('codex_delegation'),false);
  for(const bad of [{...forwarded(),namespace:'unrelated'},{...forwarded(),name:'other_tool'},
    {...forwarded(),output:forwarded().output.replace(source,'javascript:alert(1)')},
    {...forwarded(),output:forwarded().output+'\nPRIVATE_TRAILER'}, {...forwarded(),output:'ordinary tool output'}])assert.equal(messageFromItem(bad),null);
  assert.equal(messageFromItem({type:'functionCallOutput',output:'PRIVATE_TOOL_OUTPUT'}),null);
});
test('automation cards use successful native receipts, omit prompts and distinguish recorded status',()=>{
  const item=automation(),m=messageFromItem(item,'turn');
  assert.equal(m.kind,'automation');assert.equal(m.automation.frequency,'每 5 分钟');
  assert.equal(m.automation.status,'ACTIVE');assert.equal(m.automation.recorded,true);
  assert.equal(JSON.stringify(m).includes('PRIVATE'),false);
  const paused=structuredClone(item);paused.arguments.status='PAUSED';paused.result.content[1].text=JSON.stringify({automationId:'check-project',status:'PAUSED'});
  assert.equal(messageFromItem(paused).automation.status,'PAUSED');
  for(const bad of [{...item,server:'unrelated'},{...item,status:'failed'},{...item,error:{message:'failure'}},
    {...item,result:{isError:true,content:item.result.content}}, {...item,result:{content:[]}},
    {...item,result:{content:{text:'not an array'}}}, {...item,arguments:{...item.arguments,mode:'delete'}}])assert.equal(messageFromItem(bad),null);
  assert.equal(scheduleLabel('FREQ=DAILY;BYHOUR=9;BYMINUTE=5'),'每天 09:05');
  assert.equal(scheduleLabel('unrecognized'),'按计划执行');
});
test('live projection includes special cards without leaking tools, duplicating inputs or creating branch points',()=>{
  const input=forwarded();
  const messages=messagesFromTurns([{turnId:'turn',status:'completed',params:{input:[{type:'text',text:'DUPLICATE_INPUT'}]},
    items:[input,automation(),{id:'tool',type:'commandExecution',aggregatedOutput:'PRIVATE'}, {id:'reply',type:'agentMessage',text:'已核对。'}]}]);
  assert.deepEqual(messages.map(m=>m.kind),['forwarded','automation','message']);
  assert.deepEqual(messages.map(m=>m.branchable),[false,false,true]);
  assert.equal(JSON.stringify(messages).includes('PRIVATE'),false);
  assert.equal(JSON.stringify(messages).includes('DUPLICATE'),false);
});
test('history paging selects special display records without letting ordinary tool logs consume a page',()=>{
  const home=mkdtempSync(join(tmpdir(),'special-history-')),id=randomUUID();let catalog;
  try{
    const s=new DatabaseSync(join(home,'state_5.sqlite'));
    s.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,updated_at INTEGER)');
    s.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,'test','test',home,0,'',1);s.close();
    const h=new DatabaseSync(join(home,'thread_history_1.sqlite'));
    h.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER)');
    const insert=h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
    const items=[forwarded(),automation(),...Array.from({length:80},(_,i)=>({id:'tool-'+i,type:'mcpToolCall',server:'unrelated',tool:'automation_update',result:{content:[{type:'text',text:'PRIVATE_TOOL'}]}})),{id:'answer',type:'agentMessage',text:'完成。'}];
    items.forEach((item,i)=>insert.run(id,'turn',i+1,item.id,item.type,JSON.stringify(item),1000+i));h.close();
    catalog=new Catalog(home);
    const latest=catalog.historyPage(id,null,2);assert.deepEqual(latest.messages.map(m=>m.kind),['automation','message']);assert.ok(latest.cursor);
    const previous=catalog.historyPage(id,latest.cursor,2);assert.deepEqual(previous.messages.map(m=>m.kind),['forwarded']);assert.equal(previous.cursor,null);
    assert.equal(JSON.stringify([latest,previous]).includes('PRIVATE'),false);
  }finally{catalog?.close();rmSync(home,{recursive:true,force:true});}
});
test('bounded legacy history recognizes forwarded response items and still hides other function outputs',()=>{
  const home=mkdtempSync(join(tmpdir(),'special-legacy-'));const catalog=new Catalog(home);
  try{
    mkdirSync(join(home,'sessions'));const path=join(home,'sessions','sample.jsonl');
    writeFileSync(path,[{type:'response_item',payload:{...forwarded(),type:'function_call_output'}},
      {type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_TOOL'}}].map(v=>JSON.stringify(v)).join('\n'));
    const page=catalog.legacyPage({rollout_path:path},null,10);
    assert.equal(page.messages.length,1);assert.equal(page.messages[0].kind,'forwarded');assert.equal(JSON.stringify(page).includes('PRIVATE'),false);
  }finally{catalog.close();rmSync(home,{recursive:true,force:true});}
});
