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
  writeFileSync(file,`import {basename} from 'node:path';import {createInterface} from 'node:readline';
if(basename(process.argv[1]||'')==='app-server'){
 const models=${JSON.stringify(models)};const rl=createInterface({input:process.stdin});
 rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
 const response=m.method==='initialize'?{result:{}}:m.method==='model/list'?{result:{data:models,nextCursor:null}}:{error:{code:-32601,message:'Unsupported fixture method'}};
 process.stdout.write(JSON.stringify({id:m.id,...response})+'\\n');});
 await new Promise(resolve=>process.stdin.once('end',resolve));rl.close();
}
`);
  return {REMOTE_CODING_CODEX:process.execPath,NODE_OPTIONS:'--import '+pathToFileURL(file).href};
}
