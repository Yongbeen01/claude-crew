import { execFile } from 'node:child_process';
import { DATA_DIR, config } from './config.js';
import { claudeBin } from './tools.js';
import { childEnv } from './runner.js';
import { logActivity } from './bus.js';
import * as jobs from './jobs.js';
import { appendSkillLines, listSkills } from './personas.js';

/**
 * What a person leaves behind.
 *
 * Firing a session throws away the one thing that took the longest to build:
 * what it worked out about this job and about working for this user. So before
 * the process dies we ask it, in its own context, what the next person would
 * need to know — and file the answer in the two places a next person actually
 * reads: the job's standing instructions, and this type's skills.
 *
 * The live session is asked first because it still has everything: tool results,
 * files it wrote, the corrections it was given. Only if it cannot answer (it
 * already exited, or came back with nothing usable) do we fall back to a cheap
 * headless pass over the transcript we kept.
 */

const SCHEMA = [
  '{',
  '  "jobName": "이 세션이 한 일의 짧고 재사용 가능한 이름. 판단이 안 서면 빈 문자열.",',
  '  "jobInstructions": ["다음에 같은 일을 맡을 사람이 알아야 할 규칙. 한 줄에 하나. 최대 5개."],',
  '  "skillName": "아래 목록 중 하나를 고르거나, 맞는 게 없으면 learned",',
  '  "skillAdditions": ["이 유형이 앞으로 항상 이렇게 하면 되는 방법. 한 줄에 하나. 최대 5개."]',
  '}',
].join('\n');

function instructions(persona) {
  const names = (persona?.skills ?? []).map((s) => s.name);
  return [
    '지금 이 자리를 떠납니다. 마지막으로 인수인계만 남기세요.',
    '',
    '이번 세션에서 알게 된 것 중, **다음 사람이 같은 일을 다시 할 때 실제로 도움이 되는 것**만 추리세요.',
    '이번 한 번만 해당하는 세부사항(파일 이름, 이번 수치, 오늘 날짜)은 넣지 마세요.',
    '사용자가 고쳐준 것, 사용자가 선호한 방식, 처음에 몰라서 헤맸던 절차 — 이런 것이 남길 값어치가 있습니다.',
    '',
    names.length ? `이 유형이 이미 가진 스킬: ${names.join(', ')}` : '이 유형에는 아직 스킬이 없습니다.',
    '',
    '아래 형식의 JSON **하나만** 출력하세요. 설명·인사·코드펜스 밖의 문장 금지.',
    '남길 것이 없는 항목은 빈 배열로 두세요. 억지로 채우지 마세요.',
    '**도구는 쓰지 마세요.** 파일을 읽거나 쓰지 말고, 아는 것만으로 바로 답하세요.',
    '',
    SCHEMA,
  ].join('\n');
}

/** The last balanced object in a reply — models like to wrap it in prose. */
function extractJson(text) {
  const s = String(text ?? '');
  for (let start = s.lastIndexOf('{'); start >= 0; start = s.lastIndexOf('{', start - 1)) {
    let depth = 0;
    for (let i = start; i < s.length; i += 1) {
      if (s[i] === '{') depth += 1;
      else if (s[i] === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function lines(value, max = 5) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? '').trim().replace(/\s+/g, ' ').replace(/^[-*•]\s*/, ''))
    .filter((v) => v.length >= 4 && v.length <= 220)
    .slice(0, max);
}

/**
 * Ask the running session. Resolves as soon as a parseable object appears, so a
 * person who answers in two seconds is not held for the whole timeout — and a
 * message that lands mid-turn still gets its answer, because we watch the text
 * rather than trusting the first `result` to be ours.
 */
function askLive(runner, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let acc = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner.off('assistant', onAssistant);
      runner.off('result', onResult);
      resolve(value);
    };
    const onAssistant = (text) => {
      acc += `\n${text}`;
      const parsed = extractJson(acc);
      if (parsed) finish(parsed);
    };
    const onResult = () => {
      const parsed = extractJson(acc);
      if (parsed) finish(parsed);
    };
    const timer = setTimeout(() => finish(extractJson(acc)), timeoutMs);
    runner.on('assistant', onAssistant);
    runner.on('result', onResult);
    if (!runner.send(prompt, { hidden: true })) finish(null);
  });
}

/** Everything we still hold about a dead session, flattened for a cold read. */
function transcriptText(runner, limit = 60) {
  return (runner?.transcript ?? [])
    .slice(-limit)
    .map((e) => {
      if (e.kind === 'text') return `${e.role === 'user' ? '사용자' : '직원'}: ${String(e.text).slice(0, 700)}`;
      if (e.kind === 'tool_use') return `(도구: ${e.text})`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function askCold(persona, body, timeoutMs) {
  return new Promise((resolve) => {
    const prompt = [
      '아래는 방금 끝난 사무실 세션의 대화 기록이다.',
      '',
      body.slice(0, 12_000),
      '',
      instructions(persona),
    ].join('\n');

    execFile(
      claudeBin(),
      [
        '-p', prompt,
        '--model', config.handoverModel,
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--tools', '',
        '--settings', '{"disableAllHooks":true}',
      ],
      { cwd: DATA_DIR, env: childEnv(), timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 22 },
      (err, stdout) => resolve(err ? null : extractJson(stdout)),
    );
  });
}

/**
 * Distil one person's session and file it. Never throws and never blocks
 * forever — a handover that goes wrong must not be able to keep someone from
 * leaving.
 *
 * @param {object} person  a crew Person
 * @returns {Promise<{jobName:string|null, jobLines:string[], skillName:string|null, skillLines:string[]}>}
 */
export async function handover(person) {
  const empty = { jobName: null, jobLines: [], skillName: null, skillLines: [] };
  if (!config.handover) return empty;

  const persona = person.persona;
  const runner = person.runner;
  // Nothing was ever asked of this person — there is nothing to learn from a
  // greeting, and a distiller run on one would invent something plausible.
  const asked = (runner?.transcript ?? []).some((e) => e.role === 'user' && e.kind === 'text');
  if (!asked) return empty;

  let parsed = null;
  try {
    if (runner?.alive) parsed = await askLive(runner, instructions(persona), config.handoverTimeoutMs);
  } catch { /* fall through to the cold read */ }

  if (!parsed) {
    const body = transcriptText(runner);
    if (body.trim()) {
      try { parsed = await askCold(persona, body, config.handoverTimeoutMs); } catch { parsed = null; }
    }
  }
  if (!parsed) {
    logActivity('handover', `${person.name} — 남길 것을 정리하지 못했습니다`, person.id);
    return empty;
  }

  const jobName = String(parsed.jobName ?? '').trim().slice(0, 60) || person.jobName || '';
  const jobLines = lines(parsed.jobInstructions);
  const skillLines = lines(parsed.skillAdditions);

  // Only write to a skill this type actually has, or to the one place we are
  // willing to create: "learned". A model-chosen new skill name would scatter
  // one-line files across the type folder.
  const existing = new Set(listSkills(persona.key).map((s) => s.name));
  const wanted = String(parsed.skillName ?? '').trim().toLowerCase();
  const skillName = existing.has(wanted) ? wanted : 'learned';

  let wroteJob = 0;
  if (jobName && jobLines.length) {
    for (const line of jobLines) if (jobs.remember(jobName, line)) wroteJob += 1;
  }
  let wroteSkill = 0;
  if (skillLines.length) {
    wroteSkill = appendSkillLines(persona.key, skillName, skillLines);
  }

  const parts = [];
  if (wroteJob) parts.push(`"${jobName}" 지침 ${wroteJob}줄`);
  if (wroteSkill) parts.push(`${persona.label} 스킬 ${wroteSkill}줄`);
  logActivity(
    'handover',
    parts.length ? `${person.name} — 인수인계 ${parts.join(' · ')}` : `${person.name} — 새로 남길 것은 없었습니다`,
    person.id,
  );

  return {
    jobName: jobName || null,
    jobLines: wroteJob ? jobLines : [],
    skillName: wroteSkill ? skillName : null,
    skillLines: wroteSkill ? skillLines : [],
  };
}
