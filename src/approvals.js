import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { bus, logActivity } from './bus.js';

/**
 * Tool approvals.
 *
 * A session running headless has nobody to ask, so an unlisted tool is just
 * denied and the person reports that it "can't do that". We install a hook
 * pointing back here and **hold the hook's HTTP response open** until someone
 * clicks in the office; the decision is the response body.
 *
 * The hook is `PreToolUse`, not `PermissionRequest`. Measured (see
 * scripts/spike/README.md): in `-p` mode `PermissionRequest` is never called at
 * all — in any permission mode — while `PreToolUse` fires for every tool, its
 * `permissionDecision` genuinely allows or blocks the call, and its response can
 * be delayed. That is the entire mechanism this app's approvals rest on.
 */

/** id -> pending approval (an in-flight PermissionRequest hook request) */
const pending = new Map();
/** last N resolved approvals, for the history strip */
const history = [];
/**
 * People allowed to approve themselves. A long job shouldn't need forty clicks.
 * Memory only: it dies with the daemon and with the person, so nobody inherits
 * it by accident.
 */
const trusted = new Set();
/**
 * People on their way out. Their last turn is a handover — a statement, not
 * work — so any tool it reaches for is refused immediately instead of hanging
 * on a card nobody is going to press. Without this, one stray Write during the
 * handover parks the whole departure forever: holds have no timeout by design.
 */
const leaving = new Set();

let viewerCount = 0;

export function setViewerCount(n) {
  viewerCount = n;
  if (n === 0 && config.holdOnlyWhenViewerConnected) {
    // Nobody can see the office any more — never hold a session hostage to a UI
    // that isn't on screen.
    for (const a of [...pending.values()]) resolve(a.id, config.approvalFallbackDecision, 'no-viewer');
  }
}

export function listApprovals() {
  return [...pending.values()].map(toPublic);
}

export function approvalHistory(limit = 30) {
  return history.slice(-limit);
}

export function isTrusted(personId) {
  return trusted.has(personId);
}

/**
 * Trust a person, or take it back. Trusting also clears whatever they are
 * waiting on right now — the point of the switch is "stop asking me".
 * Returns how many pending cards it swallowed.
 */
export function setTrusted(personId, on) {
  if (!personId) return 0;
  if (!on) {
    trusted.delete(personId);
    return 0;
  }
  trusted.add(personId);
  let n = 0;
  for (const a of [...pending.values()]) {
    if (a.personId === personId && resolve(a.id, 'allow', 'trust')) n += 1;
  }
  return n;
}

/** Nothing this person asks for from now on waits for a click. */
export function setLeaving(personId) {
  if (!personId) return 0;
  leaving.add(personId);
  return resolveAllFor(personId, 'deny', 'leaving');
}

export function forget(personId) {
  trusted.delete(personId);
  leaving.delete(personId);
  resolveAllFor(personId, config.approvalFallbackDecision, 'gone');
}

export function approvalsByPerson() {
  const map = new Map();
  for (const a of pending.values()) {
    if (!map.has(a.personId)) map.set(a.personId, []);
    map.get(a.personId).push(toPublic(a));
  }
  return map;
}

function toPublic(a) {
  return {
    id: a.id,
    personId: a.personId,
    tool: a.tool,
    title: a.title,
    detail: a.detail,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

/** Reading and searching don't need a click; acting on the world does. */
function isAutoAllowed(tool) {
  if (tool.startsWith('mcp__office__')) return true; // the app's own tools
  // Watching the browser work is the whole point of the checkbox — asking to
  // approve every click would make it unwatchable. Turning the checkbox off
  // detaches the browser entirely, so this only applies where it was asked for.
  if (tool.startsWith('mcp__playwright__')) return true;
  return (config.autoAllowTools ?? []).includes(tool);
}

/**
 * Called by the PreToolUse hook.
 * @returns {{held:false, decision:string} | {held:true, promise:Promise<string>}}
 */
export function requestApproval(personId, payload) {
  const tool = payload.tool_name || 'unknown';
  const input = payload.tool_input ?? {};

  if (isAutoAllowed(tool)) return { held: false, decision: 'allow' };

  // Already walking to the door — the handover is words, not work.
  if (personId && leaving.has(personId)) return { held: false, decision: 'deny' };

  if (personId && trusted.has(personId)) {
    logActivity('trust', `자동 승인 · ${describeTool(tool, input)}`, personId, { decision: 'allow' });
    return { held: false, decision: 'allow' };
  }
  // Optional: some people would rather nothing ever blocks on a tab being open.
  if (config.holdOnlyWhenViewerConnected && viewerCount === 0) {
    return { held: false, decision: config.approvalFallbackDecision };
  }
  if (!personId) return { held: false, decision: config.approvalFallbackDecision };

  const id = randomUUID();
  const createdAt = Date.now();
  const record = {
    id,
    personId,
    tool,
    input,
    title: describeTool(tool, input),
    detail: detailOf(tool, input),
    createdAt,
    expiresAt: config.approvalHoldMs > 0 ? createdAt + config.approvalHoldMs : 0,
    toolUseId: payload.tool_use_id || '',
  };

  const promise = new Promise((res) => { record._settle = res; });
  if (config.approvalHoldMs > 0) {
    record.timer = setTimeout(() => resolve(id, config.approvalFallbackDecision, 'timeout'), config.approvalHoldMs);
    record.timer.unref?.();
  }

  pending.set(id, record);
  logActivity('approval', `승인 요청 · ${record.title}`, personId, { approvalId: id });
  bus.emit('approvals', listApprovals());
  return { held: true, promise };
}

export function resolve(id, decision, by = 'user') {
  const record = pending.get(id);
  if (!record) return false;
  clearTimeout(record.timer);
  pending.delete(id);

  const entry = { ...toPublic(record), decision, by, resolvedAt: Date.now(), waitedMs: Date.now() - record.createdAt };
  history.push(entry);
  if (history.length > 100) history.shift();
  record._settle(decision);

  if (by === 'user') {
    const label = { allow: '승인', deny: '거부', ask: '보류' }[decision] ?? decision;
    logActivity('approval-done', `${label} · ${record.title}`, record.personId, { decision });
  }
  bus.emit('approvals', listApprovals());
  bus.emit('approval-resolved', entry);
  return true;
}

export function resolveAllFor(personId, decision, by = 'user') {
  let n = 0;
  for (const a of [...pending.values()]) {
    if (a.personId === personId && resolve(a.id, decision, by)) n += 1;
  }
  return n;
}

/**
 * The decision happened elsewhere (a rule matched, the turn ended). Drop the
 * card so the office stops showing a request nobody is waiting on.
 *
 * A finishing tool clears only *its own* card: without the id check, one of
 * several parallel calls completing would sweep away a request that is still
 * very much blocking.
 */
export function resolveStale(personId, toolUseId, why = 'session') {
  let n = 0;
  for (const a of [...pending.values()]) {
    if (a.personId !== personId) continue;
    if (toolUseId && a.toolUseId !== toolUseId) continue;
    if (toolUseId && !a.toolUseId) continue;
    if (resolve(a.id, config.approvalFallbackDecision, why)) n += 1;
  }
  return n;
}

/**
 * PreToolUse response shape. `allow` bypasses the permission check outright;
 * `deny` blocks the call and shows the reason to the person; `ask` falls back to
 * the normal flow, which in headless mode means the tool does not run.
 */
export function decisionBody(decision) {
  const reason = {
    allow: '사용자가 허용했습니다.',
    deny: '사용자가 거부했습니다. 다른 방법을 찾거나 사용자에게 물어보세요.',
    ask: '지금은 승인할 사람이 없습니다. 사용자에게 무엇이 필요한지 말하고 기다리세요.',
  }[decision] ?? '';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** One-line human summary of what is being asked for. */
export function describeTool(tool, input = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  switch (tool) {
    case 'Bash': return `실행: ${truncate(s(input.command), 90)}`;
    case 'Write': return `새 파일 쓰기: ${tail(s(input.file_path))}`;
    case 'Edit': return `파일 수정: ${tail(s(input.file_path))}`;
    case 'Read': return `파일 읽기: ${tail(s(input.file_path))}`;
    case 'WebFetch': return `웹 요청: ${truncate(s(input.url), 70)}`;
    case 'WebSearch': return `웹 검색: ${truncate(s(input.query), 70)}`;
    default:
      if (tool?.startsWith('mcp__')) return `외부 도구: ${tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}`;
      return `${tool} 실행`;
  }
}

function detailOf(tool, input = {}) {
  if (tool === 'Bash') return [input.description, input.command].filter(Boolean).join('\n');
  if (tool === 'Edit') {
    return [
      input.file_path,
      input.old_string ? `- ${truncate(String(input.old_string), 400)}` : '',
      input.new_string ? `+ ${truncate(String(input.new_string), 400)}` : '',
    ].filter(Boolean).join('\n');
  }
  if (tool === 'Write') return `${input.file_path ?? ''}\n${truncate(String(input.content ?? ''), 800)}`;
  try { return truncate(JSON.stringify(input, null, 1), 900); } catch { return ''; }
}

function truncate(v, n) {
  if (!v) return '';
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

function tail(p) {
  if (!p) return '';
  return p.split(/[\\/]/).filter(Boolean).slice(-3).join('/');
}
