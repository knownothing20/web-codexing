import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

let cached, pending;
function executable() {
  if (process.env.REMOTE_CODING_CODEX) return process.env.REMOTE_CODING_CODEX;
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const files = readdirSync(dir).map(d => join(dir, d, 'codex.exe')).filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (files.length) return files[0];
  } catch {}
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export function readCatalog(method, params) {
  if (!['skills/list', 'account/rateLimits/read'].includes(method)) throw new Error('不支持的只读请求');
  const label = method === 'skills/list' ? 'Skill 目录' : '账号额度';
  return new Promise((resolve, reject) => {
    const child = spawn(executable(), ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const rl = createInterface({ input: child.stdout }); let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); rl.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(label + '读取超时')), 15000);
    const send = data => child.stdin.write(JSON.stringify(data) + '\n');
    child.on('error', () => finish(new Error('Codex CLI 不可用'))); child.stdin.on('error', () => {});
    child.on('exit', () => { if (!done) finish(new Error(label + '读取进程已退出')); });
    rl.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id === 'init') {
          if (message.error) return finish(new Error(label + '初始化失败'));
          send({ method: 'initialized' }); send({ id: 'catalog', method, params });
        } else if (message.id === 'catalog') {
          if (message.error) return finish(new Error(label + '读取失败'));
          finish(null, message.result);
        }
      } catch { finish(new Error(label + '格式无法识别')); }
    });
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'remote_coding_catalog', title: 'Remote Coding Catalog', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

const skillCache = new Map();
export async function getSkills(cwd) {
  const cached = skillCache.get(cwd);
  if (cached?.until > Date.now()) return cached.value;
  const result = await readCatalog('skills/list', { cwds: [cwd], forceReload: false });
  const entries = result.data || [];
  const all = new Map();
  for (const entry of entries) for (const skill of entry.skills || []) if (skill.enabled) {
    const id = createHash('sha256').update(skill.path).digest('hex').slice(0, 24);
    all.set(id, { id, name: skill.name, displayName: skill.interface?.displayName || skill.name,
      description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
      path: skill.path, scope: skill.scope, plugin: !!skill.pluginId });
  }
  const value = { skills: [...all.values()], warnings: entries.reduce((n, e) => n + (e.errors?.length || 0), 0), source: 'codex-skills-list' };
  if (skillCache.size >= 32) skillCache.delete(skillCache.keys().next().value);
  skillCache.set(cwd, { value, until: Date.now() + 5 * 60000 });
  return value;
}

export async function getModels() {
  if (cached && cached.until > Date.now()) return cached.value;
  if (pending) return pending;
  pending = readModels().then(value => {
    cached = { value, until: Date.now() + 5 * 60000 }; return value;
  }).finally(() => { pending = null; });
  return pending;
}
function readModels() {
  // This short-lived helper only reads model/list. It never resumes a thread or submits inference.
  return new Promise((resolve, reject) => {
    const child = spawn(executable(), ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const rl = createInterface({ input: child.stdout });
    let done = false, models = [];
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); rl.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('模型列表读取超时，请稍后重试')), 15000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Error('未找到可用的 Codex CLI，无法读取模型列表')));
    child.stdin.on('error', () => {});
    child.on('exit', () => { if (!done) finish(new Error('Codex 模型列表进程提前退出')); });
    rl.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id === 'initialize') {
          if (message.error) return finish(new Error('Codex 模型目录初始化失败'));
          send({ method: 'initialized' });
          send({ id: 'models', method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else if (message.id === 'models') {
          if (message.error) return finish(new Error('Codex 模型列表读取失败'));
          models.push(...message.result.data.filter(m => !m.hidden).map(m => ({
            id: m.model, name: m.displayName || m.model, description: m.description || '',
            efforts: (m.supportedReasoningEfforts || []).map(e => typeof e === 'string' ? e : e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort,
          })));
          if (message.result.nextCursor) send({ id: 'models', method: 'model/list', params: { limit: 100, cursor: message.result.nextCursor } });
          else finish(null, { models, source: 'codex-model-list' });
        }
      } catch { finish(new Error('Codex 模型目录返回了无法识别的数据')); }
    });
    send({ id: 'initialize', method: 'initialize', params: {
      clientInfo: { name: 'remote_coding_catalog', title: 'Remote Coding Catalog', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    } });
  });
}
