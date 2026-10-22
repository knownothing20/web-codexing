import {generatedHistorySql} from './generated-images.mjs';
// Only validated desktop display records may cross the tool-output boundary.
export const specialHistorySql = `(
  item_type IN ('userMessage','agentMessage','steeringUserMessage')
  OR ${generatedHistorySql}
  OR (item_type='functionCallOutput' AND json_valid(item_json)
    AND json_extract(item_json,'$.name')='send_message_to_thread'
    AND json_extract(item_json,'$.namespace')='codex_app')
  OR (item_type='mcpToolCall' AND json_valid(item_json)
    AND json_extract(item_json,'$.server')='codex_app'
    AND json_extract(item_json,'$.tool')='automation_update'
    AND json_extract(item_json,'$.status')='completed')
)`;

function object(value) {
  if (typeof value === 'string' && value.length <= 65536) { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function shortText(value, limit) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, limit) : ''; }
export function scheduleLabel(rule) {
  const fields = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').map(part => part.split('=')));
  const every = Math.max(1, Math.min(9999, Number(fields.INTERVAL) || 1));
  const unit = { MINUTELY:'分钟', HOURLY:'小时', DAILY:'天', WEEKLY:'周', MONTHLY:'个月' }[fields.FREQ];
  if (!unit) return '按计划执行';
  let label = every === 1 ? `每${unit}` : `每 ${every} ${unit}`;
  if (fields.FREQ === 'DAILY' && every === 1) label = '每天';
  if (fields.BYHOUR != null && fields.BYMINUTE != null && /^\d{1,2}$/.test(fields.BYHOUR) && /^\d{1,2}$/.test(fields.BYMINUTE)
    && Number(fields.BYHOUR) < 24 && Number(fields.BYMINUTE) < 60)
    label += ` ${fields.BYHOUR.padStart(2,'0')}:${fields.BYMINUTE.padStart(2,'0')}`;
  return label;
}

export function specialMessageFromItem(item, id, turnId) {
  if (['functionCallOutput', 'function_call_output', 'FunctionCallOutput'].includes(item.type)
    && item.name === 'send_message_to_thread' && item.namespace === 'codex_app' && typeof item.output === 'string' && item.output.length <= 65536) {
    const match = /^\s*<codex_delegation>\s*<source_thread_id>([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i.exec(item.output);
    if (!match || !match[2].trim()) return null;
    return { id, turnId, role:'user', kind:'forwarded', text:match[2].trim(), forwarded:{ threadId:match[1] } };
  }
  if (!['mcpToolCall', 'McpToolCall'].includes(item.type) || item.server !== 'codex_app' || item.tool !== 'automation_update'
    || item.status !== 'completed' || item.error || item.result?.isError) return null;
  const args = object(item.arguments);
  if (!args || !['create','update','view'].includes(args.mode)) return null;
  // The app returns a small receipt separately from the tool's explanatory text.
  const receipt = (Array.isArray(item.result?.content) ? item.result.content : []).slice(0, 8).map(part => part?.type === 'text' ? object(part.text) : null)
    .find(value => value && typeof value.automationId === 'string');
  if (!receipt || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(receipt.automationId)) return null;
  const name = shortText(args.name, 120) || '定时任务';
  const schedule = shortText(args.rrule, 256);
  const status = ['ACTIVE','PAUSED'].includes(receipt.status) ? receipt.status : ['ACTIVE','PAUSED'].includes(args.status) ? args.status : 'UNKNOWN';
  return { id, turnId, role:'assistant', kind:'automation', text:name, automation:{ id:receipt.automationId, name,
    schedule, frequency:schedule ? scheduleLabel(schedule) : '频率未记录', status, action:args.mode, recorded:true } };
}
