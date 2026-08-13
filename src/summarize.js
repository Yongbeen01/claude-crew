import { execFile } from 'node:child_process';
import { DATA_DIR, config } from './config.js';
import { childEnv } from './runner.js';

/**
 * The one line under each nameplate: "what is this person doing right now".
 *
 * Runs the CLI in print mode with Haiku, so it uses the login the user already
 * has — no API key, no second account. Two flags matter:
 *   --no-session-persistence  keeps these throwaway runs from showing up as
 *                             ghost sessions in anyone's session registry
 *   disableAllHooks           stops the summary run from calling our own
 *                             PermissionRequest hook and looping back in
 *
 * Ported from claude-office, where it does exactly this job.
 */

/** personId -> { at, signature, text } */
const cache = new Map();
const queue = [];
let running = 0;

/** Re-summarise only when the work actually changed, not on every poll. */
function signature(person) {
  const r = person.runner;
  if (!r) return '';
  const lastUser = [...r.transcript].reverse().find((e) => e.role === 'user' && e.kind === 'text');
  return [lastUser?.text ?? '', r.recentTools.join(','), r.turns].join('|');
}

/** The instruction is what the caption should describe; tools are supporting detail. */
function material(person) {
  const t = person.runner.transcript;
  const lastUser = [...t].reverse().find((e) => e.role === 'user' && e.kind === 'text');
  if (!lastUser) return null;
  const tools = t.filter((e) => e.kind === 'tool_use').slice(-4).map((e) => e.text);
  return { instruction: String(lastUser.text).slice(0, 500), tools };
}

function prompt({ instruction, tools }) {
  return [
    '다음은 사무실 직원이 방금 받은 지시다.',
    `지시: ${instruction}`,
    tools.length ? `쓴 도구: ${tools.join(', ')}` : '',
    '',
    '이 사람이 무슨 일을 하는 중인지 한국어 명사구 하나로만 답해라.',
    '규칙: 12자 이내. 문장 금지. 조사·서술어 금지. 따옴표·마침표 금지. 설명 금지.',
    '좋은 예: 수불부 검산 / 제안서 초안 / 메일 정리 / 매출 표 정리',
    '나쁜 예: 사용자가 요청한 파일을 만들고 있습니다',
  ].filter(Boolean).join('\n');
}

/** Reject anything that came back as a sentence rather than a label. */
function clean(raw) {
  const line = String(raw).trim().split('\n').filter(Boolean).pop() ?? '';
  const text = line.replace(/^["'\s]+|["'.\s]+$/g, '');
  if (!text || text.length > 14) return '';
  if (/(습니다|입니다|해요|없어|하는 중입|것으로|합니다)/.test(text)) return '';
  return text;
}

function pump(apply) {
  while (running < config.summaryConcurrency && queue.length) {
    const person = queue.shift();
    const bits = material(person);
    if (!bits) continue;
    running += 1;
    execFile(
      config.claudeBin,
      [
        '-p', prompt(bits),
        '--model', config.summaryModel,
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--tools', '',
        '--settings', '{"disableAllHooks":true}',
      ],
      { cwd: DATA_DIR, env: childEnv(), timeout: config.summaryTimeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        running -= 1;
        const text = err ? '' : clean(stdout);
        if (text) {
          cache.set(person.id, { ...cache.get(person.id), text });
          apply(person.id, text);
        }
        pump(apply);
      },
    );
  }
}

/**
 * Refresh the caption for everyone who needs one.
 * @param {Array} people   crew Person instances
 * @param {(id:string, text:string)=>void} apply
 */
export function refreshSummaries(people, apply) {
  if (!config.summaries) return;
  const now = Date.now();
  for (const person of people) {
    // A person working a named job shows the job name instead — no point paying
    // for a summary nobody will see.
    if (person.jobName) continue;
    if (!person.runner?.alive) continue;
    // Nothing to describe until the user has actually asked for something —
    // summarising the greeting produces noise.
    if (!material(person)) continue;

    const sig = signature(person);
    const prev = cache.get(person.id);
    if (prev && prev.signature === sig) continue;
    if (prev && now - prev.at < config.summaryMinIntervalMs) continue;

    cache.set(person.id, { at: now, signature: sig, text: prev?.text ?? '' });
    if (!queue.includes(person)) queue.push(person);
  }
  pump(apply);
}

export function forgetSummary(personId) {
  cache.delete(personId);
}
