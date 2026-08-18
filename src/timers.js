import { bus, logActivity } from './bus.js';
import { notify } from './toast.js';
import { paths, readJson, writeJson } from './store.js';

/**
 * The app owns the clock, not the session.
 *
 * A language model cannot wait two hours — it would have to hold a turn open,
 * burning context and dying with the process. So 토끼 calls start_timer and
 * ends its turn; this module sleeps, and when a mark comes up it *pokes the
 * session*, which then talks to the user in its own voice.
 */

/** Minutes before the end that we speak up. */
const MARKS = [60, 30, 15];

let state = { tasks: [], timer: null };
/** @type {NodeJS.Timeout[]} */
let handles = [];
/** Injected by index.js to avoid a require cycle with crew.js. */
let poke = () => {};

export function bindPoke(fn) {
  poke = fn;
}

function persist() {
  writeJson(paths.tasks(), state);
  bus.emit('tasks', publicState());
}

export function load() {
  const saved = readJson(paths.tasks(), null);
  if (saved?.tasks) state = { tasks: saved.tasks, timer: null };
  // A timer never survives a restart: the person holding it is gone too.
  persist();
  return publicState();
}

export function publicState() {
  const t = state.timer;
  return {
    tasks: state.tasks,
    timer: t ? { ...t, remainingMs: Math.max(0, t.endsAt - Date.now()) } : null,
  };
}

export function saveTaskList(tasks, { personId } = {}) {
  state.tasks = (Array.isArray(tasks) ? tasks : [])
    .map((t) => ({
      name: String(t?.name ?? '').trim(),
      minutes: Number.isFinite(Number(t?.minutes)) ? Math.max(1, Math.round(Number(t.minutes))) : null,
      done: false,
    }))
    .filter((t) => t.name);
  persist();
  const total = state.tasks.reduce((sum, t) => sum + (t.minutes ?? 0), 0);
  logActivity('tasks', `오늘 할 일 ${state.tasks.length}건 · 합계 ${total}분`, personId ?? null);
  return state.tasks;
}

function clearHandles() {
  for (const h of handles) clearTimeout(h);
  handles = [];
}

export function startTimer({ taskName, minutes, personId }) {
  const name = String(taskName ?? '').trim();
  const mins = Math.max(1, Math.round(Number(minutes) || 0));
  if (!name || !mins) return null;

  clearHandles();
  const startedAt = Date.now();
  state.timer = { taskName: name, minutes: mins, personId, startedAt, endsAt: startedAt + mins * 60_000 };

  for (const mark of MARKS) {
    const at = state.timer.endsAt - mark * 60_000;
    if (at <= Date.now()) continue; // a 30-minute task never gets a "1 hour left"
    handles.push(setTimeout(() => fire(mark), at - Date.now()));
  }
  handles.push(setTimeout(() => fire(0), state.timer.endsAt - Date.now()));

  persist();
  logActivity('timer', `${name} — ${mins}분 시작`, personId ?? null);
  return publicState().timer;
}

export function stopTimer({ personId } = {}) {
  const t = state.timer;
  clearHandles();
  state.timer = null;
  persist();
  if (t) {
    const spent = Math.round((Date.now() - t.startedAt) / 60_000);
    logActivity('timer', `${t.taskName} — 종료 (실제 ${spent}분)`, personId ?? t.personId ?? null);
    return { ...t, actualMinutes: spent };
  }
  return null;
}

function fire(mark) {
  const t = state.timer;
  if (!t) return;

  const text = mark === 0
    ? `[타이머] "${t.taskName}" 시간이 다 됐습니다. 사용자에게 알리고, 끝났는지 물어보세요. 끝났다면 실제 걸린 시간을 확인해 log_work 로 남기고 stop_timer 를 호출하세요.`
    : `[타이머] "${t.taskName}" ${mark}분 남았습니다. 사용자에게 한 문장으로 알리세요. 재촉하지 마세요.`;

  bus.emit('timer', { mark, taskName: t.taskName, personId: t.personId, at: Date.now() });
  logActivity('timer', mark === 0 ? `${t.taskName} — 시간 종료` : `${t.taskName} — ${mark}분 전`, t.personId ?? null);

  // The person says it, not the app: the message lands in their own voice and
  // in the conversation the user is already reading.
  poke(t.personId, text);
  // 화면 밖에서도 닿아야 하는 말이다. 시간이 다 된 것은 긴급으로 띄운다 —
  // 사용자가 직접 치울 때까지 화면에 남고 알람 소리가 반복된다. 남은 시간을
  // 알리는 쪽은 그럴 일이 아니라 보통 알림이다.
  notify({
    title: mark === 0 ? '토끼 · 시간이 다 됐어요' : '토끼',
    body: mark === 0
      ? `"${t.taskName}" 시간이 다 됐습니다`
      : `"${t.taskName}" ${mark}분 남았습니다`,
    urgent: mark === 0,
  });

  if (mark === 0) {
    clearHandles();
    state.timer = null;
    persist();
  }
}

export function shutdown() {
  clearHandles();
}
