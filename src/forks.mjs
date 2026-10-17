import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { executable } from './models.mjs';

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Only runs on a branch click. Never resumes/rolls back the source or starts inference.
export function forkStoredThread(bin, threadId, lastTurnId) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe','pipe','ignore'] });
    const lines = createInterface({ input: child.stdout }); let done = false, submitted = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      if (error) { error.unknown = submitted; reject(error); } else resolve(result);
    };
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const timer = setTimeout(() => finish(new Error('分支结果尚未确认，请先查看会话列表，不要重复创建')), 25000);
    child.on('error', () => finish(new Error('无法启动 Codex 分支服务')));
    child.on('exit', () => { if (!done) finish(new Error('分支服务已断开，请核对会话列表')); });
    child.stdin.on('error', () => finish(new Error('分支连接已断开，请核对会话列表')));
    lines.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id === 'init') {
        if (m.error) return finish(new Error('分支服务初始化失败'));
        send({method:'initialized'}); submitted = true;
        send({id:'fork', method:'thread/fork', params:{threadId,lastTurnId,excludeTurns:true}});
      } else if (m.id === 'fork') {
        if (m.error) { if ([-32601,-32602].includes(m.error.code)) submitted = false; return finish(new Error('Codex 未完成分支请求；请先核对会话列表与该轮历史')); }
        const id = m.result?.thread?.id;
        if (!uuid.test(id || '') || id === threadId) return finish(new Error('无法确认新分支，请核对桌面列表'));
        finish(null, {id});
      }
    });
    send({id:'init',method:'initialize',params:{clientInfo:{name:'web_codexing_fork',title:'Web Codexing',version:'0.1.0'},capabilities:{experimentalApi:true}}});
  });
}

export class ForkService {
  constructor(runtime, { bin = executable(), run = forkStoredThread, capability = null } = {}) {
    this.root = resolve(runtime, 'forks'); this.bin = bin; this.run = run; this.capability = capability;
    this.pending = new Map();
  }
  async supported() {
    if (this.capability) return this.capability();
    const stamp = this.bin + ':' + statSync(this.bin).mtimeMs;
    if (this.checked === stamp) return;
    mkdirSync(this.root, {recursive:true});
    if (!this.checking) this.checking = (async () => {
      const dir = mkdtempSync(join(this.root, 'schema-'));
      try {
        await execute(this.bin, ['app-server','generate-json-schema','--out',dir], {windowsHide:true,timeout:15000,maxBuffer:65536});
        const schema = JSON.parse(readFileSync(join(dir,'v2','ThreadForkParams.json'),'utf8'));
        if (!schema.properties?.lastTurnId || !schema.properties?.excludeTurns) throw new Error();
        this.checked = stamp;
      } catch { throw new Error('本机 Codex 版本尚不支持按回复位置分支，请先更新客户端'); }
      finally { if (resolve(dir).startsWith(this.root + sep)) rmSync(dir, {recursive:true,force:true}); }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async create({sid,requestId,threadId,lastTurnId}) {
    if (!uuid.test(requestId || '') || !uuid.test(threadId || '') || typeof lastTurnId !== 'string' || !lastTurnId || lastTurnId.length > 200) throw new Error('分支参数无效');
    const owner = createHash('sha256').update(sid).digest('hex');
    const file = join(this.root, requestId + '.json');
    const read = () => {
      const receipt = JSON.parse(readFileSync(file,'utf8'));
      if (receipt.owner !== owner || receipt.threadId !== threadId || receipt.lastTurnId !== lastTurnId) throw new Error('分支请求标识已被使用');
      if (receipt.result) return receipt.result;
      if (receipt.failed) { const error=new Error(receipt.failed);error.unknown=false;throw error; }
      const error = new Error('该分支请求结果尚未确认，请先查看会话列表，不要重复创建'); error.unknown = true; throw error;
    };
    if (this.pending.has(requestId)) { await this.pending.get(requestId); return read(); }
    if (existsSync(file)) return read();
    if (this.pending.size) throw new Error('正在创建另一条分支，请稍后');
    await this.supported();
    // Recheck after the asynchronous capability probe.
    if (this.pending.has(requestId)) { await this.pending.get(requestId); return read(); }
    if (existsSync(file)) return read();
    if (this.pending.size) throw new Error('正在创建另一条分支，请稍后');
    mkdirSync(this.root,{recursive:true});
    const receipt = {owner,threadId,lastTurnId};
    writeFileSync(file,JSON.stringify(receipt),{flag:'wx'});
    const job = this.run(this.bin,threadId,lastTurnId).then(result => {
      try { writeFileSync(file,JSON.stringify({...receipt,result})); } catch { const error=new Error('分支已创建但回执保存失败，请先查看会话列表');error.unknown=true;throw error; }
      return result;
    }).catch(error=>{if(!error.unknown)writeFileSync(file,JSON.stringify({...receipt,failed:error.message}));throw error;}).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId,job); return job;
  }
}
