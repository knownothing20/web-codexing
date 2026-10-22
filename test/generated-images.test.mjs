import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {messagesFromTurns,messageFromItem} from '../src/state.mjs';
import {ImageStore} from '../src/attachments.mjs';
import {Catalog} from '../src/catalog.mjs';

const image=n=>({id:'image-'+n,type:'imageGeneration',status:'completed',savedPath:resolve('example',n+'.png'),
  revisedPrompt:'PRIVATE_PROMPT',result:'PRIVATE_BASE64',failure:null});
const answer={id:'answer',type:'agentMessage',phase:'final_answer',text:'已生成四张。'};

test('native generated images form one ordered gallery after the answer without tool data',()=>{
  const turns=[{turnId:'turn',status:'completed',items:[image(1),{id:'progress',type:'agentMessage',phase:'commentary',text:'生成中'},image(2),image(3),image(4),answer]}];
  const messages=messagesFromTurns(turns),gallery=messages.at(-1);
  assert.equal(messages.at(-2).id,'answer');assert.equal(gallery.id,'generated:turn');
  assert.equal(gallery.imageSources.length,4);assert.equal(gallery.branchable,false);assert.equal(messages.at(-2).branchable,true);
  assert.deepEqual(gallery.imageSources.map(s=>s.name),[1,2,3,4].map(n=>'生成图片 '+n));
  const projected=new ImageStore().project(gallery,'chat'),wire=JSON.stringify(projected);
  assert.equal(projected.images.length,4);assert.equal(projected.images[0].generated,true);
  for(const secret of ['PRIVATE_PROMPT','PRIVATE_BASE64','savedPath',resolve('example')])assert.equal(wire.includes(secret),false);
});

test('in-progress, failed, arbitrary tools and unsafe saved paths never become generated galleries',()=>{
  for(const item of [{...image(1),status:'inProgress'},{...image(1),failure:{message:'PRIVATE'}},
    {...image(1),savedPath:'https://example.com/image.png'},{...image(1),savedPath:'\\\\host\\share\\image.png'},
    {...image(1),savedPath:resolve('secret.txt')},{...image(1),type:'mcpToolCall'}])assert.equal(messageFromItem(item),null);
  const messages=messagesFromTurns([{turnId:'one',items:[image(1),image(1)]},{turnId:'two',items:[image(2)]}]);
  assert.equal(messages.length,2);assert.equal(messages[0].imageSources.length,1);assert.notEqual(messages[0].id,messages[1].id);
});

test('history cursor splits preserve complete ordered galleries and exclude image prompts/results',()=>{
  const home=mkdtempSync(join(tmpdir(),'generated-history-')),id=randomUUID();let catalog;
  try{
    const s=new DatabaseSync(join(home,'state_5.sqlite'));
    s.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,updated_at INTEGER)');
    s.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,'test','test',home,0,'',1);s.close();
    const h=new DatabaseSync(join(home,'thread_history_1.sqlite'));
    h.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER)');
    const insert=h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
    [image(1),image(2),image(3),image(4),answer].forEach((item,i)=>insert.run(id,'turn',i+1,item.id,item.type,JSON.stringify(item),1000+i));
    h.close();catalog=new Catalog(home);
    const latest=catalog.historyPage(id,null,1);assert.ok(latest.cursor);
    assert.deepEqual(latest.messages.map(m=>m.kind),['message','generatedImages']);
    const older=catalog.historyPage(id,latest.cursor,2);
    for(const page of [latest,older]){
      const gallery=page.messages.find(m=>m.kind==='generatedImages');
      assert.equal(gallery.id,'generated:turn');assert.deepEqual(gallery.imageSources.map(s=>s.path),[1,2,3,4].map(n=>image(n).savedPath));
      assert.equal(JSON.stringify(page).includes('PRIVATE'),false);
    }
  }finally{catalog?.close();rmSync(home,{recursive:true,force:true});}
});
