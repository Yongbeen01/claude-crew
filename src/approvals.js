import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { bus, logActivity } from './bus.js';
import { assess } from './risk.js';

/**
 * Tool approvals.
 *
 * A session running headless has nobody to ask, so a held call is just a call
 * that never happens until someone answers. We install a hook pointing back
 * here and **hold the hook's HTTP response open** until someone clicks in the
 * office; the decision is the response body.
 *
 * 기본은 **허용**이다. 카드가 뜨는 것은 risk.js 가 위험하다고 본 일뿐 —
 * 되돌리기 어려운 변경, 자격·개인정보, 환경변수 노출. 왜 그렇게 두는지는
 * risk.js 위쪽에 적어 두었다.
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

/** Nothing this person asks for from now on waits for a click. */
export function setLeaving(personId) {
  if (!personId) return 0;
  leaving.add(personId);
  return resolveAllFor(personId, 'deny', 'leaving');
}

export function forget(personId) {
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
    why: a.why,
    kind: a.kind,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

/** 앱이 자기 자신에게 거는 도구는 물어볼 것이 없다. */
function isOurs(tool) {
  if (tool.startsWith('mcp__office__')) return true; // the app's own tools
  // 브라우저가 일하는 것을 지켜보는 게 목적인 도구다. 클릭마다 물어보면
  // 볼 수가 없다.
  if (tool.startsWith('mcp__playwright__')) return true;
  return false;
}

/**
 * Called by the PreToolUse hook.
 * @returns {{held:false, decision:string} | {held:true, promise:Promise<string>}}
 */
export function requestApproval(personId, payload) {
  const tool = payload.tool_name || 'unknown';
  const input = payload.tool_input ?? {};

  if (isOurs(tool)) return { held: false, decision: 'allow' };

  // Already walking to the door — the handover is words, not work.
  if (personId && leaving.has(personId)) return { held: false, decision: 'deny' };

  // 기본은 허용이다. 물어보는 것은 되돌리기 어렵거나, 자격·개인정보를
  // 건드리거나, 환경변수를 흘릴 수 있는 일뿐 — 판단은 risk.js 가 한다.
  const verdict = (config.askAlwaysTools ?? []).includes(tool)
    ? { risky: true, kind: 'machine', why: '항상 물어보도록 설정된 도구입니다' }
    : assess(tool, input);
  if (!verdict.risky) return { held: false, decision: 'allow' };

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
    why: verdict.why ?? '',
    kind: verdict.kind ?? 'machine',
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
