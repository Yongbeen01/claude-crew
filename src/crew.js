import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, SESSIONS_DIR } from './config.js';
import { bus, logActivity } from './bus.js';
import { Runner } from './runner.js';
import { loadPersona } from './personas.js';
import { paths, readJson, writeJson } from './store.js';

/**
 * Who is sitting in the office right now.
 *
 * Unlike claude-office — which had to *guess* a session's state by tailing a
 * transcript on disk — we own the process, so state here is a fact: the runner
 * tells us when a turn starts and ends.
 */

/** Seat + name survive a restart so the same person keeps their desk. */
const NAMES = [
  '감자', '고구마', '단호박', '완두콩', '옥수수', '가지', '당근', '무말랭이',
  '두부', '유부', '메추리알', '표고', '팽이', '느타리', '연근', '우엉',
  '김밥', '떡국', '수제비', '만두', '전복', '홍합', '멸치', '북어',
];

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
  }

  get state() {
    if (!this.runner) return 'offline';
    const r = this.runner;
    if (!r.alive) return 'exited';
    if (r.state === 'working') return 'working';
    if (r.state === 'starting') return 'starting';
    if (Date.now() - r.lastActivityAt > config.idleAfterMs) return 'sleeping';
    return 'idle';
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
      createdAt: this.createdAt,
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

function nextName() {
  const used = new Set([...people.values()].map((p) => p.name));
  const free = NAMES.filter((n) => !used.has(n));
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function persist() {
  writeJson(paths.crew(), {
    people: [...people.values()].map((p) => ({
      id: p.id, personaKey: p.personaKey, name: p.name, seat: p.seat, jobName: p.jobName,
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
function attach(person) {
  const r = person.runner;

  r.on('change', () => announce());

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

  r.on('tool', (t) => {
    if (t.phase === 'start') {
      logActivity('tool', `${person.name} — ${t.name}`, person.id);
    }
    announce();
  });

  r.on('result', (ev) => {
    if (ev.is_error) {
      logActivity('error', `${person.name} — 턴 실패: ${String(ev.result ?? '').slice(0, 80)}`, person.id);
    }
    announce();
  });

  r.on('exit', ({ code, error }) => {
    logActivity(
      code === 0 ? 'exit' : 'error',
      code === 0 ? `${person.name} 퇴근` : `${person.name} 비정상 종료: ${String(error ?? code).slice(0, 120)}`,
      person.id,
    );
    announce();
  });
}

/**
 * Seat a new person and start their Claude session.
 * @param {string} personaKey
 * @param {{watch?: boolean, appendSystemPrompt?: string, mcpServers?: object, settingsJson?: string, jobName?: string}} [opts]
 */
export function hire(personaKey, opts = {}) {
  const persona = loadPersona(personaKey);
  if (!persona) throw new Error(`unknown persona: ${personaKey}`);

  const seat = nextSeat();
  if (seat < 0) throw new Error(`자리가 다 찼습니다 (최대 ${config.maxSeats}명)`);

  const person = new Person({
    id: randomUUID(),
    personaKey,
    name: nextName(),
    seat,
    watch: opts.watch,
  });
  person.persona = persona;
  person.jobName = opts.jobName ?? null;

  person.runner = new Runner({
    personId: person.id,
    persona,
    appendSystemPrompt: opts.appendSystemPrompt,
    pluginDirs: [persona.dir],
    mcpServers: opts.mcpServers ?? {},
    settingsJson: opts.settingsJson,
  });

  people.set(person.id, person);
  attach(person);
  person.runner.start();

  // The person opens the conversation, not the user. The kickoff never appears
  // in the transcript as something the user typed.
  if (persona.kickoff) person.runner.send(persona.kickoff, { hidden: true });

  persist();
  announce();
  return person;
}

export function send(id, text, opts = {}) {
  const person = people.get(id);
  if (!person?.runner) return false;
  const ok = person.runner.send(text, opts);
  if (ok && !opts.hidden) {
    bus.emit('message', { personId: id, role: 'user', text, at: Date.now() });
    logActivity('prompt', `${person.name} ← ${String(text).slice(0, 60)}`, id);
  }
  announce();
  return ok;
}

export function fire(id, { keepFiles = true } = {}) {
  const person = people.get(id);
  if (!person) return false;
  person.runner?.stop();
  people.delete(id);
  if (!keepFiles) {
    fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  }
  persist();
  announce();
  return true;
}

export function setWatch(id, on) {
  const person = people.get(id);
  if (!person) return false;
  person.watch = !!on;
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

export function shutdownAll() {
  for (const person of people.values()) person.runner?.stop();
}

/**
 * Seats and names from the last run are shown as empty desks, not revived:
 * a Claude session cannot outlive the process that owned its stdin.
 */
export function lastSeating() {
  return readJson(paths.crew(), { people: [] });
}
