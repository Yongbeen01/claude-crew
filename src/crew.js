import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, baseUrl, SESSIONS_DIR } from './config.js';
import { bus, logActivity } from './bus.js';
import { Runner } from './runner.js';
import { loadPersona } from './personas.js';
import { paths, readJson, writeJson } from './store.js';
import { issueToken, revokeTokensFor, mcpConfigFor, officeToolNames, tokenFor, bindHooks } from './mcpServer.js';
import { briefing } from './jobs.js';
import * as approvals from './approvals.js';
import { forgetSummary } from './summarize.js';
import { handover } from './handover.js';
import { ensureGroup } from './toolbox.js';

/**
 * Who is sitting in the office right now.
 *
 * Unlike claude-office — which had to *guess* a session's state by tailing a
 * transcript on disk — we own the process, so state here is a fact: the runner
 * tells us when a turn starts and ends.
 */

/** Seat + name survive a restart so the same person keeps their desk. */
/** @type {Map<string, Person>} */
const people = new Map();

class Person {
  constructor({ id, personaKey, name, seat, watch }) {
    this.id = id;
    this.personaKey = personaKey;
    this.name = name;
    this.seat = seat;
    this.watch = !!watch;
    this.jobName = null;
    this.summary = '';
    this.createdAt = Date.now();
    this.runner = null;
    this.persona = null;
    /** set the moment 종료 is confirmed — the office plays the walk out from it */
    this.leavingAt = null;
  }

  get state() {
    if (!this.runner) return 'offline';
    const r = this.runner;
    // On the way out, and it outranks everything: whatever else is true of this
    // person, what the office should show is someone packing.
    if (this.leavingAt) return 'leaving';
    if (!r.alive) return 'exited';
    // Waiting on a click outranks "working" — it is the one state the user has
    // to do something about.
    if (this.approvalCount > 0) return 'awaiting_approval';
    if (r.state === 'working') return 'working';
    if (r.state === 'starting') return 'starting';
    if (Date.now() - r.lastActivityAt > config.idleAfterMs) return 'sleeping';
    return 'idle';
  }

  get approvalCount() {
    return approvals.approvalsByPerson().get(this.id)?.length ?? 0;
  }

  toJSON() {
    const r = this.runner?.toJSON() ?? null;
    return {
      id: this.id,
      personaKey: this.personaKey,
      personaLabel: this.persona?.label ?? this.personaKey,
      sprite: this.persona?.sprite ?? this.personaKey,
      name: this.name,
      seat: this.seat,
      watch: this.watch,
      jobName: this.jobName,
      // A person working a known job shows the job name; otherwise the Haiku
      // one-liner. Never both — the nameplate has one line.
      caption: this.jobName || this.summary || '',
      state: this.state,
      approvalCount: this.approvalCount,
      trusted: approvals.isTrusted(this.id),
      createdAt: this.createdAt,
      leavingAt: this.leavingAt,
      session: r,
      // FNV-1a over the id: the same person always gets the same face.
      seed: hashCode(this.id),
    };
  }
}

function hashCode(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function takenSeats() {
  return new Set([...people.values()].map((p) => p.seat));
}

function nextSeat() {
  const taken = takenSeats();
  for (let i = 0; i < config.maxSeats; i += 1) if (!taken.has(i)) return i;
  return -1;
}

/**
 * A person is called what they are.
 *
 * They used to get a random food name, which was charming and useless: you had
 * to remember that 팽이 was the one who does spreadsheets. The type IS the
 * useful name, so that is the name. A second one of the same type is numbered
 * rather than renamed, because "표고버섯 2" still tells you what it does.
 */
function nextName(personaKey) {
  const label = loadPersona(personaKey)?.label ?? personaKey;
  const used = new Set([...people.values()].map((p) => p.name));
  if (!used.has(label)) return label;
  for (let n = 2; n < 99; n += 1) {
    const candidate = `${label} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return label;
}

/**
 * 다음에 앱이 켜질 때 이 사람들을 그대로 다시 앉히기 위해 필요한 전부.
 *
 * 핵심은 `sessionId` 다 — 그것만 있으면 `--resume` 이 나눈 대화를 통째로 다시
 * 붙여 준다. `busy` 는 끊길 때 일하는 중이었는지로, 되살릴 때 "이어서 하세요"
 * 라고 말을 걸지 정한다. 그래서 이 파일은 사람이 들고 날 때만이 아니라
 * **일을 시작하고 끝낼 때마다** 다시 쓰인다 (wireRunner) — 앱이 곱게 죽지
 * 못하는 경우(크래시·PC 재부팅)에도 마지막 상태가 남아 있어야 하기 때문이다.
 */
function persist() {
  writeJson(paths.crew(), {
    people: [...people.values()].map((p) => ({
      id: p.id, personaKey: p.personaKey, name: p.name, seat: p.seat, jobName: p.jobName,
      watch: p.watch,
      sessionId: p.runner?.sessionId ?? null,
      model: p.runner?.model ?? null,
      effort: p.runner?.effort ?? null,
      busy: p.runner?.state === 'working',
      at: Date.now(),
    })),
  });
}

export function snapshot() {
  return [...people.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.toJSON());
}

export function get(id) {
  return people.get(id) ?? null;
}

function announce() {
  bus.emit('crew', snapshot());
}

/** Wire a runner's events into the office bus. */
function wireRunner(person) {
  const r = person.runner;

  // 일하는 중인지가 바뀔 때마다 명단을 다시 적는다. 앱이 곱게 죽을 때만
  // 적으면 정작 필요한 경우 — 크래시·PC 재부팅 — 에 아무것도 안 남는다.
  let wasBusy = null;
  r.on('change', () => {
    const busy = r.state === 'working';
    if (busy !== wasBusy) {
      wasBusy = busy;
      persist();
    }
    announce();
  });

  r.on('init', () => {
    logActivity('spawn', `${person.name}(${person.persona.label}) 출근`, person.id);
    announce();
  });

  r.on('delta', (text) => {
    bus.emit('delta', { personId: person.id, text });
  });

  r.on('assistant', (text) => {
    bus.emit('message', { personId: person.id, role: 'assistant', text, at: Date.now() });
  });

  // What the person is doing this instant, so the chat can say "생각 중" only
  // when it is actually thinking. The thinking block carries no text — current
  // models never return the raw reasoning — but its timing is real.
  r.on('phase', (phase) => {
    bus.emit('phase', { personId: person.id, phase, at: Date.now() });
  });

  r.on('tool', (t) => {
    // The chat folds these away; only the ones the user opens are ever read.
    bus.emit('tool', { personId: person.id, ...t, at: Date.now() });
    if (t.phase === 'start') {
      logActivity('tool', `${person.name} — ${t.name}`, person.id);
    } else {
      // The tool ran, so its approval card is settled — drop just that card.
      // We learn this from the output stream, which is why the session needs no
      // PostToolUse hook.
      approvals.resolveStale(person.id, t.id, 'done');
    }
    announce();
  });

  r.on('result', (ev) => {
    // The turn is over — the chat clears everything it was showing while the
    // person worked and keeps only the answer.
    bus.emit('turn-end', { personId: person.id, isError: !!ev.is_error, at: Date.now() });
    if (ev.is_error && !r.stillborn) {
      logActivity('error', `${person.name} — 턴 실패: ${String(ev.result ?? '').slice(0, 80)}`, person.id);
    }
    // Turn over: nothing can still be blocking on a decision.
    approvals.resolveAllFor(person.id, config.approvalFallbackDecision, 'turn-end');
    announce();
  });

  r.on('exit', ({ code, error }) => {
    // 이어 붙이기가 실패한 것뿐이면 곧 새 대화로 다시 앉는다 (revive). 그
    // 사이에 "비정상 종료" 를 적으면, 스스로 고쳐지는 일을 사고로 읽게 된다.
    if (r.stillborn) return;
    logActivity(
      code === 0 ? 'exit' : 'error',
      code === 0 ? `${person.name} 퇴근` : `${person.name} 비정상 종료: ${String(error ?? code).slice(0, 120)}`,
      person.id,
    );
    announce();
  });
}

/**
 * 한 사람의 세션을 세운다. 새로 뽑을 때와 되살릴 때가 **같은 코드**를 지난다 —
 * 여기가 갈라지면 되살아난 사람만 조용히 다른 도구·다른 권한으로 앉게 된다.
 */
function makeRunner(person, {
  model, effort, appendSystemPrompt = '', mcpServers, sessionId, resume = false,
} = {}) {
  const token = issueToken(person.id);
  return new Runner({
    personId: person.id,
    persona: person.persona,
    model,
    effort,
    sessionId,
    resume,
    appendSystemPrompt,
    pluginDirs: [person.persona.dir],
    mcpServers: {
      ...mcpConfigFor(token),
      ...(person.watch ? browserMcp(person) : {}),
      ...(mcpServers ?? {}),
    },
    alwaysAllowTools: officeToolNames(),
    settingsJson: sessionSettings(token),
  });
}

/**
 * Seat a new person and start their Claude session.
 * @param {string} personaKey
 * @param {{watch?: boolean, appendSystemPrompt?: string, mcpServers?: object, settingsJson?: string, jobName?: string, model?: string, effort?: string}} [opts]
 */
export function hire(personaKey, opts = {}) {
  const persona = loadPersona(personaKey);
  if (!persona) throw new Error(`unknown persona: ${personaKey}`);

  const seat = nextSeat();
  if (seat < 0) throw new Error(`자리가 다 찼습니다 (최대 ${config.maxSeats}명)`);

  // Whatever this type needs beyond the shared document packages. Started, not
  // waited on: the person sits down now and their skill knows to say so if the
  // tool is not there yet.
  for (const group of persona.toolbox) ensureGroup(group);

  const person = new Person({
    id: randomUUID(),
    personaKey,
    name: nextName(personaKey),
    seat,
    // A type may need the visible browser to do its job at all (영화감독 watches
    // the video in it), so it can ask for one. The checkbox can only add.
    watch: opts.watch === true || persona.watch === true,
  });
  person.persona = persona;
  person.jobName = opts.jobName ?? null;

  // Everything already known about this job rides in on the system prompt, so
  // the user does not have to explain it a second time.
  const brief = opts.jobName ? briefing(opts.jobName) : '';

  person.runner = makeRunner(person, {
    model: pickModel(opts.model),
    effort: pickEffort(opts.effort),
    appendSystemPrompt: [brief, opts.appendSystemPrompt].filter(Boolean).join('\n\n'),
    mcpServers: opts.mcpServers,
  });

  people.set(person.id, person);
  wireRunner(person);
  person.runner.start();

  // The person opens the conversation, not the user. The kickoff never appears
  // in the transcript as something the user typed.
  const kickoff = opts.jobName ? jobKickoff(persona, opts.jobName) : persona.kickoff;
  if (kickoff) person.runner.send(kickoff, { hidden: true });

  persist();
  announce();
  return person;
}

/**
 * The only hook a person needs. `PreToolUse` fires for every tool call in
 * headless mode and its response decides whether the call happens, so this is
 * where "허용 / 거부" in the office actually takes effect. The long timeout is
 * the hold — the call is released the moment it is decided or the turn ends.
 * (`PermissionRequest` looks like the right hook and is never called in `-p`
 * mode; that cost an afternoon. See scripts/spike/README.md.)
 */
function sessionSettings(token) {
  const hold = config.approvalHoldMs > 0 ? Math.ceil(config.approvalHoldMs / 1000) + 15 : 86_400;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'http', url: `${baseUrl}/hook/${token}/PreToolUse`, timeout: hold }] },
      ],
    },
  });
}

/**
 * A person hired onto a known job greets differently: they already have the
 * briefing, so they either ask the one thing they still need or just start.
 */
function jobKickoff(persona, jobName) {
  return [
    `당신은 방금 자리에 앉았고, "${jobName}" 일을 맡았습니다.`,
    '시스템 프롬프트에 지난번까지 정리된 방식이 들어 있습니다. 이미 아는 것은 묻지 마세요.',
    '한 문장으로 무슨 일을 맡았는지 확인하고, 정말 필요한 질문만 한 번에 물어보세요.',
    '물어볼 게 없으면 바로 시작하세요.',
  ].join(' ');
}

/** Hand a running person a job after the fact (drag a card onto them). */
export function assignJob(id, jobName) {
  const person = people.get(id);
  if (!person?.runner) return false;
  person.jobName = jobName || null;
  persist();
  announce();
  if (!jobName) return true;

  const brief = briefing(jobName);
  person.runner.send(
    [
      `[업무 배정] 지금부터 "${jobName}" 일을 맡습니다.`,
      brief,
      '한 문장으로 확인하고, 이 내용으로 판단이 안 서는 것만 물어보세요. 없으면 바로 시작하세요.',
    ].filter(Boolean).join('\n\n'),
    { hidden: true },
  );
  logActivity('job', `${person.name} ← ${jobName}`, id);
  return true;
}

/** Timers call this so a countdown mark is spoken by the person, not the app. */
export function poke(id, text) {
  const person = people.get(id);
  if (!person?.runner?.alive) return false;
  return person.runner.send(text, { hidden: true });
}

export function send(id, text, opts = {}) {
  const person = people.get(id);
  if (!person?.runner) return false;
  // Someone on the way out is writing their handover; a new instruction now
  // would either be dropped on the floor or derail it.
  if (person.leavingAt && !opts.hidden) return false;
  const ok = person.runner.send(text, opts);
  if (ok && !opts.hidden) {
    bus.emit('message', { personId: id, role: 'user', text, at: Date.now() });
    logActivity('prompt', `${person.name} ← ${String(text).slice(0, 60)}`, id);
  }
  announce();
  return ok;
}

/**
 * Copy attachments into this person's work folder. The message then names them
 * by absolute path and the person opens them with its own tools — no special
 * file-passing channel, and the files stay put for the rest of the session.
 */
export function attach(id, files) {
  const person = people.get(id);
  if (!person) return [];
  const dir = path.join(SESSIONS_DIR, id, 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files ?? []) {
    // Only the basename: a crafted name must not be able to write outside the
    // person's own folder.
    const name = path.basename(String(f?.name ?? '')).replace(/[\\/:*?"<>|]/g, '_');
    if (!name || !f?.data) continue;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(String(f.data), 'base64'));
    saved.push(file);
  }
  if (saved.length) logActivity('file', `${person.name} ← 파일 ${saved.length}개`, id);
  return saved;
}

/**
 * Someone was dragged to the door and the user said yes.
 *
 * Two things run at once. The person is asked what the next one should know and
 * the answer is filed away (handover.js), while the office plays them crying,
 * packing and trudging out. Whichever finishes last decides when the seat
 * actually empties — a fast answer must not cut the walk short, and a slow one
 * must not leave a ghost sitting at the desk.
 *
 * Not cancellable on purpose. "나간 사람은 다시 돌아오지 않아요" is the promise the
 * confirmation makes, and a session cannot be un-killed anyway.
 */
export async function leave(id) {
  const person = people.get(id);
  if (!person) return false;
  if (person.leavingAt) return true; // already on the way out

  person.leavingAt = Date.now();
  logActivity('leave', `${person.name} 퇴근 — 남길 것을 정리합니다`, id);
  // From here on nothing this person does waits for a click — not what is
  // already pending, and not what the handover turn itself reaches for. A
  // single stray tool call would otherwise park the departure indefinitely.
  approvals.setLeaving(id);
  announce();

  const walk = new Promise((resolve) => { setTimeout(resolve, config.leaveAnimMs).unref?.(); });
  let result = null;
  try {
    result = await handover(person);
  } catch {
    /* nobody may be trapped in the office by a failed handover */
  }
  await walk;

  // The user may have closed the tab, or the app may be shutting down; either
  // way the person is gone from the model already.
  if (people.has(id)) fire(id);
  return result ?? true;
}

export function fire(id, { keepFiles = true } = {}) {
  const person = people.get(id);
  if (!person) return false;
  person.runner?.stop();
  revokeTokensFor(id);
  approvals.forget(id);
  forgetSummary(id);
  people.delete(id);
  if (!keepFiles) {
    fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  }
  persist();
  announce();
  return true;
}

/** Push a fresh snapshot without waiting for the next runner event. */
export function touch(id) {
  if (id && !people.has(id)) return false;
  announce();
  return true;
}

/**
 * "작업 과정 지켜보기" — attach a *visible* browser to this person.
 *
 * @playwright/mcp runs headed by default (`--headless` is the opt-out), so
 * simply attaching the server is what makes the work visible. The tool set of a
 * running session can't be changed, so the process is swapped for one resuming
 * the same conversation — the person keeps everything said so far.
 */
function browserMcp(person) {
  return {
    playwright: {
      command: 'npx',
      args: [
        '-y', '@playwright/mcp@latest',
        // A profile per person, or two people browsing at once fight over one.
        '--user-data-dir', path.join(SESSIONS_DIR, person.id, 'browser').replace(/\\/g, '/'),
        '--output-dir', path.join(SESSIONS_DIR, person.id).replace(/\\/g, '/'),
      ],
    },
  };
}

/**
 * Only ever hand argv something the CLI knows.
 *
 * A bad `--effort` is not refused — it warns on stderr and quietly falls back to
 * the default, so the office would go on displaying a setting nobody is running
 * under. An empty return means "no override", which leaves the type's default.
 */
function pickModel(v) {
  const s = String(v ?? '').trim();
  return config.models.includes(s) ? s : null;
}

function pickEffort(v) {
  const s = String(v ?? '').trim();
  return config.efforts.includes(s) ? s : null;
}

/**
 * Change what this one person runs on, mid-session.
 *
 * The CLI cannot re-tune a live session, so the process is swapped for one
 * resuming the same conversation — the same move as attaching a browser, and
 * the person keeps everything said so far.
 *
 * Refused while they are working: a restart drops whatever is in flight, and
 * `--resume` would then pick the conversation back up *without* the answer to
 * the question just asked. Losing a turn silently is worse than waiting.
 */
export async function setTuning(id, { model, effort } = {}) {
  const person = people.get(id);
  if (!person?.runner) return { ok: false, error: 'unknown person' };

  const nextModel = pickModel(model) ?? person.runner.model;
  const nextEffort = pickEffort(effort) ?? person.runner.effort;
  if (nextModel === person.runner.model && nextEffort === person.runner.effort) {
    return { ok: true, model: nextModel, effort: nextEffort };
  }
  if (person.leavingAt) return { ok: false, error: '나가는 중입니다' };
  if (person.runner.state === 'working') {
    return { ok: false, error: '지금 일하는 중이라 바꾸지 못합니다. 끝나면 바꿔주세요.' };
  }

  logActivity('model', `${person.name} — ${nextModel}${nextEffort ? ` · ${nextEffort}` : ''}`, id);
  announce();
  await person.runner.restart({ model: nextModel, effort: nextEffort });
  announce();
  return { ok: true, model: nextModel, effort: nextEffort };
}

export async function setWatch(id, on) {
  const person = people.get(id);
  if (!person?.runner) return false;
  if (person.watch === !!on) return true;
  person.watch = !!on;

  const token = tokenFor(person.id);
  const servers = { ...mcpConfigFor(token), ...(person.watch ? browserMcp(person) : {}) };
  logActivity('watch', person.watch
    ? `${person.name} — 브라우저를 띄워 보여줍니다`
    : `${person.name} — 브라우저를 내립니다`, id);

  announce();
  await person.runner.restart({ mcpServers: servers });
  announce();
  return true;
}

export function setSummary(id, text) {
  const person = people.get(id);
  if (!person) return false;
  person.summary = String(text ?? '').trim().slice(0, 40);
  announce();
  return true;
}

export function setJob(id, jobName) {
  const person = people.get(id);
  if (!person) return false;
  person.jobName = jobName || null;
  persist();
  announce();
  return true;
}

export function transcript(id, limit = 200) {
  const person = people.get(id);
  if (!person?.runner) return [];
  return person.runner.transcript.slice(-limit);
}

export function shutdownAll(opts = {}) {
  for (const person of people.values()) person.runner?.stop(opts);
  return people.size;
}

/** 지금 자리에 앉아 있는 사람 수 — 재시작 전에 물어볼 때 쓴다. */
export function seatedCount() {
  return [...people.values()].filter((p) => p.runner?.alive).length;
}

/**
 * 지금 앱을 다시 켜면 **뭔가를 잃는** 사람 수.
 *
 * 앉아 있다고 다 해당하는 게 아니다 — 자고 있는 사람은 다시 켜도 대화 그대로
 * 돌아오니 잃을 게 없다. 잃는 쪽은 돌던 턴이 끊기는 사람(working·starting),
 * 클릭을 기다리느라 도구가 붙들려 있는 사람(awaiting_approval), 그리고
 * 인수인계를 쓰는 중인 사람(leaving)이다. 조용한 자동 업데이트가 "지금은
 * 아니다" 를 판단하는 유일한 기준.
 */
export function busyCount() {
  const held = ['working', 'starting', 'awaiting_approval', 'leaving'];
  return [...people.values()].filter((p) => held.includes(p.state)).length;
}

/** Everyone currently seated — used by the summariser. */
export function all() {
  return [...people.values()];
}

/**
 * 앱이 다시 켜졌을 때, 지난번에 앉아 있던 사람들을 그대로 다시 앉힌다.
 *
 * 오래 "세션은 앱보다 오래 살 수 없다" 고 적혀 있었고, **프로세스** 얘기로는
 * 맞는 말이었다. 하지만 대화는 프로세스가 아니라 디스크에 있다 — CLI 가
 * 자기 파일에 적어 두고, `--resume <sessionId>` 로 언제든 다시 붙는다.
 * 이미 `setWatch`/`setTuning` 이 살아 있는 사람을 그 방법으로 갈아치우고
 * 있었으니, 앱 재시작이라고 다를 이유가 없었다.
 *
 * 그래서 켤 때마다 되살린다. 업데이트로 스스로 다시 켠 것이든, 크래시였든,
 * PC 를 재부팅했든 마찬가지다 — 어제 퇴근할 때 일하던 사람이 오늘 아침에도
 * 그 자리에 앉아 있다.
 *
 * 되살리지 **않는** 경우는 셋뿐이다: 세션을 모르는 옛 형식의 기록, 사라진
 * 유형, 그리고 자리 수를 줄여서 이제 없는 자리. 이어 붙이기 자체가 실패하는
 * 경우는 미리 막지 않고 실패한 뒤에 처리한다 (Runner.startFresh) — 대화
 * 파일이 어디에 있는지를 우리가 계산하기 시작하면 그 계산이 곧 틀린다.
 */
export function revive() {
  if (people.size) return [];
  const saved = readJson(paths.crew(), { people: [] }).people ?? [];
  const back = [];

  for (const rec of saved) {
    if (!rec?.id || !rec.sessionId) continue;
    const persona = loadPersona(rec.personaKey);
    if (!persona) continue;
    if (!(rec.seat >= 0 && rec.seat < config.maxSeats)) continue;

    for (const group of persona.toolbox) ensureGroup(group);

    const person = new Person({
      id: rec.id,
      personaKey: rec.personaKey,
      name: rec.name,
      seat: rec.seat,
      watch: rec.watch,
    });
    person.persona = persona;
    person.jobName = rec.jobName ?? null;
    person.runner = makeRunner(person, {
      model: pickModel(rec.model),
      effort: pickEffort(rec.effort),
      // 일 지침은 저장해 둔 것을 쓰지 않고 지금 다시 읽는다 — 그 사이에
      // 인수인계로 갱신됐을 수 있고, 그러면 새 것이 맞다.
      appendSystemPrompt: rec.jobName ? briefing(rec.jobName) : '',
      sessionId: rec.sessionId,
      resume: true,
    });

    people.set(person.id, person);
    wireRunner(person);
    // 붙을 대화가 없으면 CLI 는 init 도 못 내보내고 죽는다. 그때만 새 대화로.
    person.runner.once('exit', () => {
      if (person.runner.init || !people.has(person.id)) return;
      logActivity('spawn', `${person.name} — 지난 대화를 찾지 못해 새로 시작합니다`, person.id);
      person.runner.startFresh();
      persist();
    });
    person.runner.start();

    if (rec.busy) person.runner.send(RESUME_NUDGE, { hidden: true });
    back.push(person);
  }

  if (back.length) {
    const who = back.map((p) => p.name).join(', ');
    logActivity('spawn', `자리로 돌아왔습니다 — ${who}`);
    persist();
    announce();
  }
  return back;
}

/**
 * 끊긴 채로 되살아난 사람에게 던지는 첫 마디.
 *
 * 대화는 통째로 돌아왔지만 **끊긴 그 턴**은 못 돌아온다 — 프로세스가 죽을 때
 * 돌던 도구는 거기서 멈췄고, 쓰다 만 파일은 쓰다 만 채다. 그래서 "이어서
 * 해라" 가 아니라 "어디까지 됐는지 먼저 보고 이어서 해라" 여야 한다.
 */
const RESUME_NUDGE = [
  '사무실이 다시 켜졌습니다. 아까 하던 일이 중간에 끊겼습니다.',
  '먼저 어디까지 했는지 확인하세요 — 만들던 파일이 있으면 그 파일을 열어 지금 상태를 보세요.',
  '이미 끝낸 것은 다시 하지 말고, 남은 것부터 이어서 하세요.',
  '무엇을 이어서 하는지 한 줄로 말하고 시작하세요.',
].join(' ');

// The MCP tools act on whoever called them; give that layer the two things it
// needs without importing crew.js back and creating a cycle.
bindHooks({
  setSummary,
  getPerson: (id) => {
    const p = people.get(id);
    return p ? { name: p.name, personaKey: p.personaKey, jobName: p.jobName } : null;
  },
});
