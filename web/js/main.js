import { Office } from './office.js';
import { avatarOf, character } from './sprites.js';
import { spring, spring2d, project, VelocityTracker } from './motion.js';
import { renderMarkdown } from './markdown.js';

/**
 * Store + SSE wiring + render loop.
 *
 * The server is the only source of truth about who is in the office; this file
 * never invents state. Streaming assistant text is the one exception — it is
 * held locally until the full message lands and replaces it.
 */

const store = {
  crew: [],
  personas: [],
  activity: [],
  approvals: [],
  jobs: [],
  tasks: { tasks: [], timer: null },
  system: null,
  usage: null,
  /** everything open on this PC, one person per window or browser tab */
  desktop: { supported: true, people: [] },
  groups: [],
  /** 창을 다 닫은 뒤에도 남는 그룹 — 다시 열기 위한 레시피 */
  savedGroups: [],
  meta: { maxSeats: 4, models: [], efforts: [] },
  /** claude·git 을 찾았는지 — 못 찾았으면 화면이 그 사실을 먼저 말한다 */
  tools: null,
  /** personId -> [{role, text, at}] */
  chats: new Map(),
  /** personId -> partial assistant text */
  streaming: new Map(),
  /**
   * personId -> what the person is doing this turn. Everything in here is
   * temporary: the chat shows it while the work happens and throws it away when
   * the answer lands, so the conversation keeps only the answers.
   * {phase, startedAt, tools:[], notes:[], toolsOpen}
   */
  work: new Map(),
  /**
   * 내가 안 보고 있는 사이에 일을 끝낸 사람들. 순수하게 화면 쪽 개념이라
   * 서버는 모른다 — 서버가 아는 건 턴이 끝났다는 사실뿐이고, 그걸 읽었는지
   * 아닌지는 이 창만 안다.
   */
  done: new Set(),
  selectedId: null,
};
window.__store = store; // handy for the Playwright checks

const el = {
  office: document.getElementById('office'),
  plates: document.getElementById('nameplates'),
  chat: document.getElementById('chat'),
  chatTitle: document.getElementById('chat-title'),
  composer: document.getElementById('composer'),
  stop: document.getElementById('stop'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  dismiss: document.getElementById('dismiss'),
  watch: document.getElementById('watch'),
  tuneModel: document.getElementById('tune-model'),
  tuneEffort: document.getElementById('tune-effort'),
  tuneNote: document.getElementById('tune-note'),
  approvals: document.getElementById('approvals'),
  approvalsPanel: document.getElementById('approvals-panel'),
  activity: document.getElementById('activity'),
  usage: document.getElementById('usage'),
  version: document.getElementById('version'),
  hint: document.getElementById('hint'),
  stage: document.querySelector('.stage'),
  tasks: document.getElementById('tasks'),
  todayPanel: document.getElementById('today-panel'),
  jobs: document.getElementById('jobs'),
  jobsPanel: document.getElementById('jobs-panel'),
  hire: document.getElementById('hire'),
  hireWatch: document.getElementById('hire-watch'),
  personaList: document.getElementById('persona-list'),
  hireCancel: document.getElementById('hire-cancel'),
  files: document.getElementById('files'),
  attachments: document.getElementById('attachments'),
  openTypes: document.getElementById('open-types'),
  authBtn: document.getElementById('auth-btn'),
  types: document.getElementById('types'),
  typeTabs: document.getElementById('type-tabs'),
  typeModel: document.getElementById('type-model'),
  typeEffort: document.getElementById('type-effort'),
  typeSystem: document.getElementById('type-system'),
  skillPick: document.getElementById('skill-pick'),
  skillBody: document.getElementById('skill-body'),
  skillNew: document.getElementById('skill-new'),
  skillDel: document.getElementById('skill-del'),
  typesSave: document.getElementById('types-save'),
  typesClose: document.getElementById('types-close'),
  typeSaved: document.getElementById('type-saved'),
  updateBar: document.getElementById('update-bar'),
  updateText: document.getElementById('update-text'),
  updateApply: document.getElementById('update-apply'),
  updateHide: document.getElementById('update-hide'),
  dragLayer: document.getElementById('drag-layer'),
  windowsPanel: document.getElementById('windows-panel'),
  windowsSummary: document.getElementById('windows-summary'),
  groupNew: document.getElementById('group-new'),
  leave: document.getElementById('leave'),
  leaveWho: document.getElementById('leave-who'),
  leaveYes: document.getElementById('leave-yes'),
  leaveNo: document.getElementById('leave-no'),
  manual: document.getElementById('manual'),
  manualTitle: document.getElementById('manual-title'),
  manualSub: document.getElementById('manual-sub'),
  manualBody: document.getElementById('manual-body'),
  manualClose: document.getElementById('manual-close'),
  manualEdit: document.getElementById('manual-edit'),
  manualEditor: document.getElementById('manual-editor'),
  manualSave: document.getElementById('manual-save'),
  deck: document.getElementById('deck'),
  deckPrev: document.getElementById('deck-prev'),
  deckNext: document.getElementById('deck-next'),
  group: document.getElementById('group'),
  groupTitle: document.getElementById('group-title'),
  groupName: document.getElementById('group-name'),
  groupList: document.getElementById('group-list'),
  groupNote: document.getElementById('group-note'),
  groupClose: document.getElementById('group-close'),
  groupDelete: document.getElementById('group-delete'),
  groupSave: document.getElementById('group-save'),
  savedPanel: document.getElementById('saved-panel'),
  saved: document.getElementById('saved'),
  savedAllBtn: document.getElementById('saved-all'),
  savedListModal: document.getElementById('saved-list'),
  savedAllList: document.getElementById('saved-all-list'),
  savedListClose: document.getElementById('saved-list-close'),
};

// ── chat width ───────────────────────────────────────────────────────────
/**
 * How wide the conversation gets to be. Long answers with tables and code want
 * far more room than a nameplate does, and how much is a matter of what you are
 * doing today — so it is a handle, and the choice is remembered.
 *
 * The room in the middle takes whatever is left and re-picks its own whole-number
 * zoom every frame (office.js `_resizeToFit`), so nothing here has to tell it.
 */
const WIDTH_KEY = 'crew.chatWidth';
const app = document.querySelector('.app');
const resizer = document.getElementById('chat-resize');

/** Never so wide that the room has no room, nor so narrow it cannot be grabbed back. */
function clampWidth(px) {
  const max = Math.max(300, Math.min(820, window.innerWidth - 560));
  return Math.round(Math.max(280, Math.min(max, px)));
}

function setChatWidth(px, { save = true } = {}) {
  const w = clampWidth(px);
  app.style.setProperty('--right-w', `${w}px`);
  resizer.setAttribute('aria-valuenow', String(w));
  if (save) { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ } }
  return w;
}

function clearChatWidth() {
  app.style.removeProperty('--right-w');
  resizer.removeAttribute('aria-valuenow');
  try { localStorage.removeItem(WIDTH_KEY); } catch { /* private mode */ }
}

function currentChatWidth() {
  return document.querySelector('.right').getBoundingClientRect().width;
}

(function restoreChatWidth() {
  let saved = null;
  try { saved = localStorage.getItem(WIDTH_KEY); } catch { /* private mode */ }
  if (saved) setChatWidth(Number(saved), { save: false });
})();

// A window that shrank below what the saved width allows gets the clamped one —
// but the saved number is left alone, so widening the window restores it.
window.addEventListener('resize', () => {
  if (app.style.getPropertyValue('--right-w')) setChatWidth(currentChatWidth(), { save: false });
});

/*
 * The drag listens on the window, not on the handle.
 *
 * Pointer capture is a request, not a guarantee. Were the handle holding the
 * listeners, losing capture mid-drag would cost us the release: the column
 * would keep its new width, the choice would never be written down, and the
 * whole window would stay stuck in the resize cursor. The window always sees
 * the release, so the commit cannot be missed.
 */
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const id = e.pointerId;
  try { resizer.setPointerCapture(id); } catch { /* capture is a nicety */ }
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');

  // Measured from the right edge of the window, which is where this column ends.
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    setChatWidth(document.documentElement.clientWidth - ev.clientX, { save: false });
  };
  const up = (ev) => {
    if (ev && ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setChatWidth(currentChatWidth()); // one write at the end, not one per pixel
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

// Double-click puts it back to whatever this screen size would have chosen.
resizer.addEventListener('dblclick', clearChatWidth);

resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 48 : 12;
  if (e.key === 'ArrowLeft') setChatWidth(currentChatWidth() + step);
  else if (e.key === 'ArrowRight') setChatWidth(currentChatWidth() - step);
  else if (e.key === 'Home' || e.key === 'Escape') clearChatWidth();
  else return;
  e.preventDefault();
});


const office = new Office(el.office, el.plates);
window.__office = office;

office.onSeatClick = (seat, at) => openHire(at);
office.onPersonClick = (id) => select(id);

// Dragged to the door. Nothing has happened yet — the question is asked first,
// and it is a real question.
office.onDropAtDoor = (id) => askToLeave(id);

// A window-person. Clicking brings that exact window (and tab) to the front;
// dragging moves them between tables.
office.onWindowClick = (key) => api('/api/desktop/focus', { method: 'POST', body: { key } });
office.onWindowDrop = async (key, target) => {
  if (target === 'new') {
    // Made the moment you let go, then opened so you can say what it is for.
    // A browser prompt before the group exists asks you to name something you
    // cannot see yet, and cancelling loses the drag entirely.
    const r = await api('/api/desktop/groups', { method: 'POST', body: { name: '새 그룹', key } });
    if (r?.group?.id) setTimeout(() => openGroupModal(r.group.id), 120);
    return;
  }
  await api('/api/desktop/assign', { method: 'POST', body: { key, groupId: target } });
};
office.onGroupClick = (id) => openGroupModal(id);
office.onGroupToggle = (id) => api(`/api/desktop/groups/${id}/toggle`, { method: 'POST' });
// The nameplate opens the group too — renaming lives inside it now.
office.onGroupRename = (id) => openGroupModal(id);

// ── api ──────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json().catch(() => ({}));
}

// ── stream ───────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/stream');

  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    Object.assign(store, {
      crew: s.crew, personas: s.personas, activity: s.activity, approvals: s.approvals,
      jobs: s.jobs, tasks: s.tasks, system: s.system, usage: s.usage, meta: s.meta,
      update: s.update, desktop: s.desktop ?? store.desktop, groups: s.groups ?? [],
      savedGroups: s.savedGroups ?? [], tools: s.tools ?? store.tools,
    });
    el.version.textContent = `v${s.meta?.version ?? ''}`;
    renderAll();
  });

  es.addEventListener('crew', (e) => { store.crew = JSON.parse(e.data); renderCrew(); });
  es.addEventListener('update', (e) => { store.update = JSON.parse(e.data); renderUpdate(); });
  es.addEventListener('approvals', (e) => { store.approvals = JSON.parse(e.data); renderApprovals(); });
  es.addEventListener('desktop', (e) => { store.desktop = JSON.parse(e.data); renderWindows(); if (openGroupId) renderGroupMembers(); });
  es.addEventListener('groups', (e) => { store.groups = JSON.parse(e.data); renderWindows(); if (openGroupId) renderGroupMembers(); });
  es.addEventListener('saved-groups', (e) => { store.savedGroups = JSON.parse(e.data); renderSavedGroups(); });
  es.addEventListener('jobs', (e) => { store.jobs = JSON.parse(e.data); renderJobs(); });
  es.addEventListener('tasks', (e) => { store.tasks = JSON.parse(e.data); renderTasks(); });
  es.addEventListener('personas', (e) => { store.personas = JSON.parse(e.data); });
  es.addEventListener('usage', (e) => { store.usage = JSON.parse(e.data); renderUsage(); });
  es.addEventListener('auth', (e) => {
    store.tools = { ...store.tools, auth: JSON.parse(e.data) };
    renderAuth();
    renderUpdate();
  });

  es.addEventListener('activity', (e) => {
    store.activity = [...store.activity, JSON.parse(e.data)].slice(-120);
    renderActivity();
  });

  es.addEventListener('delta', (e) => {
    const { personId, text } = JSON.parse(e.data);
    store.streaming.set(personId, (store.streaming.get(personId) ?? '') + text);
    workOf(personId);
    if (personId === store.selectedId) renderChat();
  });

  es.addEventListener('phase', (e) => {
    const { personId, phase } = JSON.parse(e.data);
    // A null phase means the model stopped producing blocks. The turn is not
    // over yet — a tool is probably running — so the tray stays up and just
    // stops claiming to know what is happening.
    workOf(personId).phase = phase;
    if (personId === store.selectedId) renderChat();
  });

  es.addEventListener('tool', (e) => {
    const t = JSON.parse(e.data);
    const w = workOf(t.personId);
    if (t.phase === 'start') {
      w.tools.push({ id: t.id, name: t.name, input: t.input, done: false, isError: false });
      w.order.push({ kind: 'tool', at: w.tools.length - 1 });
    } else {
      const tool = w.tools.find((x) => x.id === t.id) ?? w.tools.findLast((x) => !x.done);
      if (tool) { tool.done = true; tool.isError = !!t.isError; }
    }
    if (t.personId === store.selectedId) renderChat();
  });

  es.addEventListener('turn-end', (e) => {
    const { personId } = JSON.parse(e.data);
    // The answer has landed. Everything the person said on the way here was
    // narration — only the last thing they said is the answer, and it is the
    // only thing that stays in the conversation.
    const w = store.work.get(personId);
    const answer = w?.notes.at(-1) ?? null;
    store.work.delete(personId);
    store.streaming.delete(personId);
    if (personId !== store.selectedId) { store.done.add(personId); office.setState(store); }
    if (answer) {
      const list = store.chats.get(personId) ?? [];
      list.push({ role: 'assistant', text: answer.text, at: answer.at, settled: true });
      store.chats.set(personId, list.slice(-200));
    }
    if (personId === store.selectedId) renderChat();
  });

  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.role === 'assistant') {
      // Held, not shown as a bubble: we cannot tell an interim remark from the
      // answer until the turn ends, and by then the last one is the answer.
      const w = workOf(m.personId);
      w.notes.push({ text: m.text, at: m.at });
      w.order.push({ kind: 'note', at: w.notes.length - 1 });
      store.streaming.delete(m.personId);
    } else {
      const list = store.chats.get(m.personId) ?? [];
      list.push({ role: m.role, text: m.text, at: m.at });
      store.chats.set(m.personId, list.slice(-200));
    }
    if (m.personId === store.selectedId) renderChat();
  });

  es.onerror = () => { /* EventSource retries on its own */ };
}

// ── selection + chat ─────────────────────────────────────────────────────
async function select(id) {
  store.selectedId = id;
  store.done.delete(id); // 열어봤으면 더 알릴 게 없다
  office.selectedId = id;
  if (!store.chats.has(id)) {
    const { entries } = await api(`/api/crew/${id}/transcript`);
    store.chats.set(id, fromTranscript(entries));
  }
  renderChat();
}

/**
 * Rebuild the conversation the way the live view keeps it: what the user said,
 * and the one thing the person said at the end of each turn. The running
 * commentary and the tool calls were scaffolding — they were cleared on screen
 * when the answer arrived, so reloading must not bring them back.
 */
function fromTranscript(entries) {
  const out = [];
  const lastOfTurn = new Map();
  for (const e of entries ?? []) {
    if (e.kind !== 'text') continue;
    if (e.role === 'user') { out.push({ role: 'user', text: e.text, at: e.at }); continue; }
    if (e.role !== 'assistant') continue;
    const turn = e.turn ?? 0;
    const held = lastOfTurn.get(turn);
    const msg = { role: 'assistant', text: e.text, at: e.at };
    if (held) Object.assign(held, msg);
    else { out.push(msg); lastOfTurn.set(turn, msg); }
  }
  return out;
}

function selectedPerson() {
  return store.crew.find((p) => p.id === store.selectedId) ?? null;
}

function renderChat() {
  const person = selectedPerson();
  if (!person) {
    store.selectedId = null;
    office.selectedId = null;
    el.chatTitle.textContent = '대화';
    el.chat.innerHTML = '<p class="muted empty">사람을 고르면 여기서 대화합니다.</p>';
    el.composer.hidden = true;
    return;
  }

  // The name IS the type now, so saying both would read "표고버섯 · 표고버섯".
  // The second half only earns its place when it adds something.
  el.chatTitle.textContent = person.name.startsWith(person.personaLabel)
    ? person.name
    : `${person.name} · ${person.personaLabel}`;
  el.composer.hidden = false;
  el.watch.checked = !!person.watch;
  syncTuning(person);

  // On the way out the composer stays visible but takes nothing: a message sent
  // now would either vanish or derail the handover, and a greyed-out box says
  // that better than an error would.
  const leaving = person.state === 'leaving';
  el.prompt.disabled = leaving;
  el.send.disabled = leaving;
  el.dismiss.disabled = leaving;
  el.prompt.placeholder = leaving
    ? '나가는 중입니다 — 남길 것을 정리하고 있어요.'
    : '시킬 일을 적으세요.  (Enter 전송 · Shift+Enter 줄바꿈)';

  // 일하는 중에만 "중단" 이 뜬다. 할 수 없을 때 눌리는 버튼을 남겨 두면
  // 그 버튼이 하는 말을 사람이 믿지 않게 된다.
  //
  // "보내기" 를 가리지는 않는다 — 일하는 중에 넣은 지시는 CLI 가 줄 세워
  // 뒀다가 이어서 받는다. 멈추는 것과 덧붙이는 것은 서로 다른 일이고,
  // 둘 다 지금 할 수 있는 일이다.
  const working = person.state === 'working' && !leaving;
  el.stop.hidden = !working;
  if (working) el.stop.disabled = false;

  const msgs = store.chats.get(person.id) ?? [];
  const work = store.work.get(person.id);

  const atBottom = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 60;
  // Only what is genuinely new animates in; a re-render must never replay the
  // whole conversation.
  const shown = shownCount.get(person.id);
  shownCount.set(person.id, msgs.length);
  el.chat.innerHTML = '';
  msgs.forEach((m, i) => {
    const fresh = shown !== undefined && i >= shown && !m.settled;
    el.chat.appendChild(bubbleEl(m.role, m.text, false, fresh));
  });
  if (work) el.chat.appendChild(trayEl(person.id, work));
  if (!msgs.length && !work) {
    el.chat.innerHTML = '<p class="muted empty">아직 대화가 없습니다.</p>';
  }
  if (atBottom) el.chat.scrollTop = el.chat.scrollHeight;
}

/** personId -> how many messages were already on screen last render */
const shownCount = new Map();

function bubbleEl(role, text, streaming = false, fresh = false) {
  const d = document.createElement('div');
  d.className = `msg ${role}${streaming ? ' streaming' : ''}${fresh ? ' in' : ''}`;
  // What a person writes is Markdown — headings, lists, tables, links. What the
  // user typed is not: rendering their own text back at them differently from
  // how they typed it would be a small betrayal.
  if (role === 'assistant') d.appendChild(renderMarkdown(text));
  else d.textContent = text;
  return d;
}

// ── the work tray ────────────────────────────────────────────────────────
/**
 * What a person is doing right now, shown in place of the answer that has not
 * arrived yet. It exists only for the length of one turn.
 */
function workOf(personId) {
  let w = store.work.get(personId);
  if (!w) {
    w = { phase: null, startedAt: Date.now(), tools: [], notes: [], order: [], toolsOpen: false };
    store.work.set(personId, w);
  }
  return w;
}

const PHASE_LABEL = { thinking: '생각 중', writing: '쓰는 중', tool: '작업 중' };

function trayEl(personId, w) {
  const root = document.createElement('div');
  root.className = 'work in';

  const head = document.createElement('div');
  head.className = 'work-head';
  const running = w.tools.findLast((t) => !t.done);
  const label = running ? `${running.name} 실행 중` : (PHASE_LABEL[w.phase] ?? '일하는 중');
  head.innerHTML = '<span class="work-dot"></span>';
  const what = document.createElement('span');
  what.className = 'work-what';
  what.textContent = label;
  const elapsed = document.createElement('span');
  elapsed.className = 'work-elapsed';
  elapsed.textContent = elapsedText(w.startedAt);
  head.append(what, elapsed);
  root.appendChild(head);

  // Tools are folded into one row. Which files were read and which commands ran
  // is available, but it is not what the user came to see.
  if (w.tools.length) {
    const d = document.createElement('details');
    d.className = 'work-tools';
    d.open = w.toolsOpen;
    d.addEventListener('toggle', () => { w.toolsOpen = d.open; });
    const s = document.createElement('summary');
    const kinds = [...new Set(w.tools.map((t) => t.name))].slice(0, 3).join(', ');
    s.textContent = `도구 ${w.tools.length}번 · ${kinds}`;
    d.appendChild(s);
    for (const t of w.tools) {
      const row = document.createElement('div');
      row.className = `work-tool${t.done ? ' done' : ''}${t.isError ? ' bad' : ''}`;
      row.textContent = `${t.name} — ${toolDetail(t.input)}`;
      d.appendChild(row);
    }
    root.appendChild(d);
  }

  // What the person wrote on the way to the answer, newest last.
  const said = w.order
    .filter((o) => o.kind === 'note')
    .map((o) => w.notes[o.at]?.text)
    .filter(Boolean);
  const partial = store.streaming.get(personId);
  for (const text of said) root.appendChild(noteEl(text));
  if (partial) root.appendChild(noteEl(partial, true));

  return root;
}

function noteEl(text, streaming = false) {
  const n = document.createElement('div');
  n.className = `work-note${streaming ? ' streaming' : ''}`;
  // Half-typed Markdown is worse than none — a `**` that becomes bold two
  // keystrokes later makes the line jump. The partial stays plain and is
  // formatted the moment it is whole.
  if (streaming) n.textContent = text;
  else n.appendChild(renderMarkdown(text));
  return n;
}

/** One line of "what is this tool actually doing", never the whole payload. */
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  const s = String(v ?? Object.keys(input).join(', ')).replace(/\s+/g, ' ').trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

function elapsedText(startedAt) {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return secs < 60 ? `${secs}초` : `${Math.floor(secs / 60)}분 ${secs % 60}초`;
}

// The elapsed counter is the only thing that changes on its own, so it is
// written in place — rebuilding the tray would close a dropdown mid-read.
setInterval(() => {
  const w = store.selectedId && store.work.get(store.selectedId);
  if (!w) return;
  const node = el.chat.querySelector('.work-elapsed');
  if (node) node.textContent = elapsedText(w.startedAt);
}, 1000);

el.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.prompt.value.trim();
  const person = selectedPerson();
  if ((!text && !pending.length) || !person) return;
  el.prompt.value = '';
  el.send.disabled = true;
  // Say "생각 중" on the click, not when the first token comes back — the wait
  // before the model answers is exactly the part that needs an answer.
  const w = workOf(person.id);
  w.phase = 'thinking';
  w.startedAt = Date.now();
  renderChat();

  // 보내기가 실패하면 반드시 여기서 잡아야 한다. 위에서 이미 "생각 중" 을
  // 그려 놨기 때문에, 예외가 새어나가면 화면은 영원히 생각만 하고 사람은
  // 답을 기다린다 — 새로고침해야 사라지는데 그러면 쓴 글도 같이 사라진다.
  try {
    const files = await uploadPending(person.id);
    const r = await api(`/api/crew/${person.id}/send`, { method: 'POST', body: { text, files } });
    if (!r.ok) throw new Error(r.error ?? '보내지 못했습니다');
  } catch (err) {
    store.work.delete(person.id);
    // fetch 가 못 붙으면 "Failed to fetch" 를 던진다. 이 앱을 쓰는 사람이
    // 읽어야 할 말은 그게 아니다.
    const why = String(err?.message ?? err);
    const human = /failed to fetch|networkerror|load failed/i.test(why)
      ? '앱과 연결이 끊겼습니다. 잠시 뒤 다시 보내 보세요.'
      : why;
    pushLocal(person.id, 'error', `보내지 못했습니다 — ${human}`);
    // 쓴 글은 돌려준다. 다시 치게 만들 이유가 없다.
    if (!el.prompt.value) el.prompt.value = text;
    renderChat();
  } finally {
    el.send.disabled = false;
    el.prompt.focus();
  }
});

/**
 * 하던 일 멈추기. 사람은 자리에 그대로 있고 대화도 그대로다 — 멈추는 것은
 * 지금 돌고 있는 턴 하나뿐이라, 바로 다음 지시를 이어서 줄 수 있다.
 *
 * 끊긴 턴에서 하던 말은 문맥에 남지 않는다(spike 4 로 확인). 그래서 "중단했다"
 * 로 끝내지 않고 무엇을 하다 말았는지 다시 일러 달라고 적어 준다.
 */
el.stop.addEventListener('click', async () => {
  const person = selectedPerson();
  if (!person) return;
  el.stop.disabled = true;
  try {
    const r = await api(`/api/crew/${person.id}/stop`, { method: 'POST' });
    if (!r.ok) {
      // 누르는 사이에 턴이 스스로 끝났을 뿐이면 아무 말도 하지 않는다 —
      // 사람이 원한 결과(멈춰 있음)는 이미 이뤄졌는데 붉은 줄만 남기면
      // 버튼이 고장난 것처럼 보인다.
      if (!/하는 일이 없습니다/.test(r.error ?? '')) {
        pushLocal(person.id, 'error', r.error ?? '중단하지 못했습니다.');
      }
      store.work.delete(person.id);
      renderChat();
      return;
    }
    store.work.delete(person.id);
    pushLocal(person.id, 'notice', '중단했습니다. 하던 턴은 문맥에 남지 않으니, 이어서 시키실 때는 무엇을 하던 중이었는지 같이 적어 주세요.');
    renderChat();
    el.prompt.focus();
  } finally {
    el.stop.disabled = false;
  }
});

/** 서버에서 온 게 아니라 이 화면에서만 남기는 줄 (실패 안내 등). */
function pushLocal(personId, role, text) {
  const msgs = store.chats.get(personId) ?? [];
  msgs.push({ role, text, at: Date.now(), settled: false });
  store.chats.set(personId, msgs);
}

el.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

el.watch.addEventListener('change', async () => {
  const person = selectedPerson();
  if (!person) return;
  await api(`/api/crew/${person.id}/watch`, { method: 'POST', body: { on: el.watch.checked } });
});

// ── 이 사람이 쓰는 모델 · 생각 깊이 ────────────────────────────────────────
// 유형의 기본값에서 출발하지만, 앉아 있는 동안 이 사람만 따로 바꿀 수 있다.
// 바꾸면 세션이 같은 대화에 다시 붙으므로 지금까지 한 이야기는 남는다.
const MODEL_NOTE = { opus: '가장 똑똑함', sonnet: '기본', haiku: '가장 빠름' };
const EFFORT_LABEL = { low: '낮음', medium: '보통', high: '높음', xhigh: '아주 높음', max: '최대' };
const modelLabel = (m) => (MODEL_NOTE[m] ? `${m} · ${MODEL_NOTE[m]}` : m);
const effortLabel = (e) => EFFORT_LABEL[e] ?? e;

/** 서버가 주는 목록으로 채운다. 이미 같은 목록이면 손대지 않는다 — 매 프레임
 *  옵션을 새로 만들면 펼쳐 둔 목록이 그때마다 닫힌다. */
function fillPicker(select, values, label) {
  const want = values.join(',');
  if (select.dataset.built === want) return;
  select.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label(v);
    select.appendChild(o);
  }
  select.dataset.built = want;
}

/**
 * 값이 목록에 없으면 자리표를 하나 만들어 그걸 고른 상태로 둔다.
 *
 * 안 그러면 브라우저가 첫 항목을 선택된 것처럼 그려서, 실제로는 지정이 없는
 * 세션이 화면에서는 "낮음" 으로 보인다 — 화면이 사실과 다른 쪽이 제일 나쁘다.
 */
function syncPicker(select, value) {
  const v = value ?? '';
  if (v && ![...select.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    select.appendChild(o);
  }
  if (!v && !select.querySelector('option[value=""]')) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '지정 없음';
    select.prepend(o);
  }
  if (select.value !== v) select.value = v;
}

/** 서버 왕복 중에는 화면을 되돌리지 않는다 — 방금 고른 값이 튀어 보인다. */
let tuningBusy = false;

function syncTuning(person) {
  fillPicker(el.tuneModel, store.meta.models ?? [], modelLabel);
  fillPicker(el.tuneEffort, store.meta.efforts ?? [], effortLabel);
  if (tuningBusy) return;
  const s = person.session;
  syncPicker(el.tuneModel, s?.model);
  syncPicker(el.tuneEffort, s?.effort);
  const off = person.state === 'leaving' || person.state === 'exited';
  el.tuneModel.disabled = off;
  el.tuneEffort.disabled = off;
}

async function applyTuning() {
  const person = selectedPerson();
  if (!person) return;
  tuningBusy = true;
  el.tuneModel.disabled = true;
  el.tuneEffort.disabled = true;
  el.tuneNote.textContent = '바꾸는 중 — 하던 이야기는 그대로 이어집니다…';

  const r = await api(`/api/crew/${person.id}/tuning`, {
    method: 'POST',
    body: { model: el.tuneModel.value, effort: el.tuneEffort.value },
  });

  tuningBusy = false;
  el.tuneModel.disabled = false;
  el.tuneEffort.disabled = false;
  el.tuneNote.textContent = r.ok ? '' : (r.error ?? '바꾸지 못했습니다');
  // 거절당했으면 고른 값이 아니라 실제로 돌고 있는 값을 보여줘야 한다.
  renderChat();
}

el.tuneModel.addEventListener('change', applyTuning);
el.tuneEffort.addEventListener('change', applyTuning);

// The button and the door lead to the same place. Going out through the button
// used to end the session on the spot, which threw away everything the person
// had worked out — now both ask, and both hand over first.
el.dismiss.addEventListener('click', (e) => {
  const person = selectedPerson();
  if (!person) return;
  const r = e.currentTarget.getBoundingClientRect();
  askToLeave(person.id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
});

// ── leaving ──────────────────────────────────────────────────────────────
let leavingId = null;

function askToLeave(id, origin) {
  const person = store.crew.find((p) => p.id === id);
  if (!person || person.state === 'leaving') return;
  leavingId = id;
  el.leaveWho.textContent =
    `${person.name} · ${person.personaLabel} — 나가기 전에 이번에 알게 된 것을 `
    + '업무 지침과 이 유형의 스킬에 남깁니다.';
  openSheet(el.leave, origin);
}

el.leaveNo.addEventListener('click', () => { leavingId = null; closeSheet(el.leave); });
el.leave.addEventListener('click', (e) => {
  if (e.target === el.leave) { leavingId = null; closeSheet(el.leave); }
});

el.leaveYes.addEventListener('click', async () => {
  const id = leavingId;
  leavingId = null;
  closeSheet(el.leave);
  if (!id) return;
  // The office starts crying the moment the state comes back over the stream;
  // the seat only empties when the handover behind it is finished.
  await api(`/api/crew/${id}/leave`, { method: 'POST' });
  if (store.selectedId === id) renderChat();
});

// ── sheets ───────────────────────────────────────────────────────────────
/**
 * A sheet grows out of whatever opened it and shrinks back the same way, so the
 * relationship between the trigger and the panel is never in doubt. One spring
 * drives scrim opacity, backdrop blur and the sheet's scale together (the CSS
 * reads `--enter`), which makes the glass arrive as a material instead of a
 * flat fade. Re-opening mid-close is fine — the spring is retargeted, not
 * replaced, so it carries its velocity through the reversal.
 */
const sheets = new Map();

function openSheet(modal, origin) {
  const sheet = modal.querySelector('.sheet');
  const wasOpen = !modal.hidden;
  modal.hidden = false;
  if (!wasOpen) modal.style.setProperty('--enter', '0');

  if (origin) {
    const r = sheet.getBoundingClientRect();
    const clamp = (n) => Math.max(-20, Math.min(120, n));
    sheet.style.setProperty('--origin-x', `${clamp(((origin.x - r.left) / r.width) * 100)}%`);
    sheet.style.setProperty('--origin-y', `${clamp(((origin.y - r.top) / r.height) * 100)}%`);
  } else {
    sheet.style.removeProperty('--origin-x');
    sheet.style.removeProperty('--origin-y');
  }

  const cur = sheets.get(modal);
  const from = Number(getComputedStyle(modal).getPropertyValue('--enter')) || 0;
  if (cur) { cur.retarget(1); return; }
  sheets.set(modal, spring({
    from, to: 1, duration: 0.34, bounce: 0, epsilon: 0.004,
    onUpdate: (v) => modal.style.setProperty('--enter', String(v)),
    onDone: () => sheets.delete(modal),
  }));
  // Focus the sheet itself, not the first control: the eye should land on the
  // heading, and Esc has to work from anywhere inside.
  sheet.setAttribute('tabindex', '-1');
  sheet.focus({ preventScroll: true });
}

function closeSheet(modal) {
  if (modal.hidden) return;
  sheets.get(modal)?.stop();
  const from = Number(getComputedStyle(modal).getPropertyValue('--enter')) || 1;
  sheets.set(modal, spring({
    from, to: 0, duration: 0.28, bounce: 0, epsilon: 0.004,
    onUpdate: (v) => modal.style.setProperty('--enter', String(v)),
    onDone: () => { sheets.delete(modal); modal.hidden = true; },
  }));
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const modal of [el.leave, el.types, el.hire]) {
    if (!modal.hidden) { closeSheet(modal); break; } // topmost only — never trap
  }
});

// ── hire sheet ───────────────────────────────────────────────────────────
function openHire(origin) {
  el.personaList.innerHTML = '';
  for (const p of store.personas) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'persona';
    btn.dataset.key = p.key;

    // Draw the face at 1x on a small buffer, then upscale — same trick as the office.
    const S = 2;
    const bb = document.createElement('canvas');
    bb.width = 26; bb.height = 44;
    character(bb.getContext('2d'), 13, 43, avatarOf(hash(p.key), p.sprite), {});

    const canvas = document.createElement('canvas');
    canvas.width = bb.width * S;
    canvas.height = bb.height * S;
    canvas.style.width = `${bb.width * S}px`;
    canvas.style.height = `${bb.height * S}px`;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bb, 0, 0, bb.width, bb.height, 0, 0, canvas.width, canvas.height);

    const text = document.createElement('div');
    text.innerHTML = `<b></b><small></small><small class="spec"></small>`;
    text.querySelector('b').textContent = p.label;
    text.querySelector('small').textContent = p.blurb || '';
    // 무엇으로 돌아가는지는 부르기 전에 보여야 고르는 데 쓸모가 있다.
    text.querySelector('.spec').textContent = [
      p.model,
      p.effort ? `생각 ${effortLabel(p.effort)}` : '',
      p.watch ? '브라우저를 띄웁니다' : '',
    ].filter(Boolean).join(' · ');

    btn.append(canvas, text);
    btn.addEventListener('click', () => hire(p.key));
    el.personaList.appendChild(btn);
  }
  openSheet(el.hire, origin);
}

async function hire(personaKey) {
  closeSheet(el.hire);
  const r = await api('/api/crew', {
    method: 'POST',
    body: { personaKey, watch: el.hireWatch.checked },
  });
  if (r.ok && r.person) select(r.person.id);
  else if (r.error) alert(r.error);
}

el.hireCancel.addEventListener('click', () => closeSheet(el.hire));
el.hire.addEventListener('click', (e) => { if (e.target === el.hire) closeSheet(el.hire); });

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── attachments ──────────────────────────────────────────────────────────
// Files are copied into that person's work folder and the message names them by
// path; the person reads them with its own tools.
let pending = [];

/**
 * 한 번에 보낼 수 있는 크기.
 *
 * base64 는 원본보다 3분의 1 커지고 서버는 64MB 에서 자르므로, 그 아래에서
 * 끊는다. 넘으면 조용히 실패하는 대신 바로 말해 준다 — 예전에는 여기서 터진
 * 예외가 그대로 새어나가 "생각 중" 에 갇혔다.
 */
const MAX_UPLOAD = 45 * 1024 * 1024;

/** 버튼으로 고르든 끌어다 놓든 여기로 온다. */
function addFiles(list) {
  const incoming = [...list].filter((f) => f && f.size !== undefined);
  if (!incoming.length) return;
  // 같은 파일을 두 번 놓아도 한 번만
  const key = (f) => `${f.name}:${f.size}:${f.lastModified}`;
  const known = new Set(pending.map(key));
  const added = incoming.filter((f) => !known.has(key(f)));
  const total = [...pending, ...added].reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD) {
    attachNote(`파일이 너무 큽니다 — 한 번에 ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB 까지 보낼 수 있습니다.`);
    return;
  }
  pending.push(...added);
  renderAttachments();
}

el.files.addEventListener('change', () => {
  addFiles(el.files.files);
  el.files.value = '';
});

/** 첨부 줄에 잠깐 띄우는 한 마디. 사라지는 안내라 대화에는 남기지 않는다. */
let noteTimer = null;
function attachNote(text) {
  const note = document.createElement('span');
  note.className = 'chip warn';
  note.textContent = text;
  el.attachments.appendChild(note);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { note.remove(); }, 6000);
}

function renderAttachments() {
  el.attachments.innerHTML = '';
  pending.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${f.name} ✕`;
    chip.title = '빼기';
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => { pending.splice(i, 1); renderAttachments(); });
    el.attachments.appendChild(chip);
  });
}

/**
 * 파일 하나를 base64 로.
 *
 * `String.fromCharCode(...bytes)` 로 하면 안 된다. 바이트 하나가 인자 하나가
 * 되어서 100KB 만 넘어도 스택이 터진다 (측정: 100KB 통과, 128KB RangeError).
 * 엑셀 한 장이 그 선을 훌쩍 넘으므로 첨부는 사실상 늘 실패했다. FileReader 는
 * 같은 일을 브라우저 안에서 하고 크기 제한이 없다.
 */
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error(`${file.name} 을(를) 읽지 못했습니다`));
    r.readAsDataURL(file);
  });
}

/**
 * Base64 over JSON rather than multipart: this is localhost, the files are the
 * kind a person hands a colleague, and it saves hand-rolling a multipart parser
 * in a zero-dependency server.
 */
async function uploadPending(personId) {
  if (!pending.length) return [];
  const files = await Promise.all(pending.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
  const out = await api(`/api/crew/${personId}/files`, { method: 'POST', body: { files } });
  if (!out.ok) throw new Error(out.error ?? '파일을 옮기지 못했습니다');
  pending = [];
  renderAttachments();
  return out.files ?? [];
}

// ── 끌어다 놓기 ──────────────────────────────────────────────────────────
/**
 * 대화창 어디에 놓아도 첨부됩니다.
 *
 * 브라우저는 놓인 파일의 **원래 경로를 알려주지 않습니다**(보안). 그래서 파일을
 * 그 사람의 작업 폴더로 옮기고, 거기 경로를 메시지에 실어 보냅니다 — 엑셀처럼
 * 그냥은 안 읽히는 파일도 경로만 있으면 자기 도구로 열 수 있습니다.
 */
const dropZone = document.getElementById('chat-panel');
const dropVeil = document.getElementById('drop-veil');

/** dragleave 는 자식 위로 지나갈 때마다 뜬다 — 세어야 실제로 나간 때를 안다. */
let dragDepth = 0;

const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function showVeil(on) {
  dropVeil.hidden = !on;
  dropZone.classList.toggle('dropping', on);
}

dropZone.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  showVeil(true);
});

dropZone.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  // 이걸 막지 않으면 브라우저가 드롭을 거부한다.
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

dropZone.addEventListener('dragleave', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showVeil(false);
});

dropZone.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showVeil(false);
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  if (!selectedPerson()) {
    attachNote('먼저 파일을 건넬 사람을 고르세요.');
    return;
  }
  addFiles(files);
  el.prompt.focus();
});

// 창 밖으로 벗어나면 브라우저가 그 파일로 이동해 버린다 — 쓰던 대화가 통째로
// 날아가므로, 대화창 밖에 떨어뜨린 것은 그냥 없던 일로 한다.
window.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showVeil(false);
});

// ── type + skill editor ──────────────────────────────────────────────────
const editor = { key: null, persona: null, skill: null, dirty: new Map() };

el.openTypes.addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openTypes({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
});
el.typesClose.addEventListener('click', () => closeSheet(el.types));
el.types.addEventListener('click', (e) => { if (e.target === el.types) closeSheet(el.types); });

async function openTypes(origin) {
  openSheet(el.types, origin);
  el.typeSaved.textContent = '';
  el.typeTabs.innerHTML = '';
  for (const p of store.personas) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.dataset.key = p.key;
    b.addEventListener('click', () => loadType(p.key));
    el.typeTabs.appendChild(b);
  }
  await loadType(store.personas[0]?.key);
}

async function loadType(key) {
  if (!key) return;
  editor.key = key;
  editor.dirty.clear();
  for (const b of el.typeTabs.children) b.classList.toggle('on', b.dataset.key === key);
  const persona = await api(`/api/personas/${encodeURIComponent(key)}`);
  editor.persona = persona;
  // 이 유형을 부를 때의 기본값. 앉은 뒤에는 사람마다 대화창에서 따로 바꾼다.
  fillPicker(el.typeModel, store.meta.models ?? [], modelLabel);
  fillPicker(el.typeEffort, store.meta.efforts ?? [], effortLabel);
  syncPicker(el.typeModel, persona.model);
  syncPicker(el.typeEffort, persona.effort);
  el.typeSystem.value = persona.systemPrompt ?? '';
  el.skillPick.innerHTML = '';
  for (const s of persona.skills ?? []) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name;
    el.skillPick.appendChild(o);
  }
  selectSkill(persona.skills?.[0]?.name ?? null);
}

function selectSkill(name) {
  // Keep unsaved edits when flipping between skills in the same type.
  if (editor.skill) editor.dirty.set(editor.skill, el.skillBody.value);
  editor.skill = name;
  el.skillPick.value = name ?? '';
  const saved = editor.persona?.skills?.find((s) => s.name === name);
  el.skillBody.value = editor.dirty.get(name) ?? saved?.body ?? '';
  el.skillBody.disabled = !name;
}

el.skillPick.addEventListener('change', () => selectSkill(el.skillPick.value));

el.skillNew.addEventListener('click', () => {
  const name = prompt('새 스킬 이름 (영문 소문자와 하이픈)', 'new-skill');
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return;
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  el.skillPick.appendChild(o);
  editor.persona.skills.push({ name, body: '' });
  selectSkill(name);
  el.skillBody.value = `---\nname: ${name}\ndescription: 언제 이 스킬을 쓰는지 한 문장으로.\n---\n\n## 어떻게 하는지\n`;
  el.skillBody.focus();
});

el.skillDel.addEventListener('click', async () => {
  if (!editor.skill) return;
  if (!confirm(`"${editor.skill}" 스킬을 지울까요?`)) return;
  await api(`/api/personas/${encodeURIComponent(editor.key)}/skills/${encodeURIComponent(editor.skill)}`, { method: 'DELETE' });
  await loadType(editor.key);
});

el.typesSave.addEventListener('click', async () => {
  if (!editor.key) return;
  el.typesSave.disabled = true;
  if (editor.skill) editor.dirty.set(editor.skill, el.skillBody.value);

  const meta = await api(`/api/personas/${encodeURIComponent(editor.key)}`, {
    method: 'POST',
    body: {
      systemPrompt: el.typeSystem.value,
      // 빈 값은 보내지 않는다 — 서버가 모르는 값이라며 저장 전체를 거절한다.
      ...(el.typeModel.value ? { model: el.typeModel.value } : {}),
      ...(el.typeEffort.value ? { effort: el.typeEffort.value } : {}),
    },
  });
  if (meta && meta.ok === false) {
    el.typesSave.disabled = false;
    el.typeSaved.textContent = meta.error ?? '저장하지 못했습니다';
    return;
  }
  for (const [name, body] of editor.dirty) {
    await api(`/api/personas/${encodeURIComponent(editor.key)}/skills/${encodeURIComponent(name)}`, {
      method: 'POST', body: { body },
    });
  }
  editor.dirty.clear();
  el.typesSave.disabled = false;
  el.typeSaved.textContent = '저장했습니다 — 다음에 부르는 사람부터 적용됩니다.';
  setTimeout(() => { el.typeSaved.textContent = ''; }, 4000);
});

// ── panels ───────────────────────────────────────────────────────────────
function renderCrew() {
  // 이 아래로는 남은 게 없다 — 화면 검증이 "다 떴다" 를 물어볼 수 있게 표시해 둔다.
window.__crewReady = true;
// 방을 직접 그려 보게 하는 손잡이. 포도송이가 알 스무 개에서 어떻게 되는지는
// 진짜 창 스무 개를 띄워 보지 않고는 확인할 길이 없어서 열어 둔다.
window.__office = office;
office.setState(store);
  const seated = store.crew.length;
  const leaving = store.crew.some((p) => p.state === 'leaving');
  // 늘 떠 있는 사용법 안내는 없앴다 — 한 번 해 보면 아는 것들이고, 화면에서
  // 방이 가져갈 수 있는 높이를 계속 깎아먹었다. 남긴 것은 지금 당장 막혀서
  // 알려줄 값어치가 있는 두 가지뿐이다.
  const note = leaving
    ? '나가는 사람이 이번에 알게 된 것을 정리하는 중입니다.'
    : seated >= (store.meta.maxSeats ?? 6)
      ? '자리가 다 찼습니다. 문으로 한 명 내보내면 새로 부를 수 있습니다.'
      : '';
  el.hint.textContent = note;
  el.hint.hidden = !note;

  // Someone who has left is gone: their conversation goes with them, or the
  // next person to take that seat would inherit it.
  const here = new Set(store.crew.map((p) => p.id));
  for (const id of [...store.chats.keys()]) {
    if (here.has(id)) continue;
    store.chats.delete(id);
    store.work.delete(id);
    shownCount.delete(id);
  }
  if (store.selectedId && !here.has(store.selectedId)) renderChat();
}

/**
 * The left panel is only a summary and a way to start a group — the tables in
 * the room are where the work is actually done, because dragging one person to
 * another table is the whole interaction and a list cannot express it.
 */
function renderWindows() {
  const d = store.desktop ?? {};
  office.setState(store);
  const people = d.people ?? [];
  el.windowsPanel.hidden = !d.supported;
  if (!d.supported) return;

  const grouped = people.filter((p) => p.groupId).length;
  const tabs = people.filter((p) => p.kind === 'tab').length;
  const rows = [
    ['열린 창', `${people.length - tabs}개`],
    ['브라우저 탭', d.uia ? `${tabs}개` : '읽을 수 없음'],
    ['그룹', `${store.groups.length}개 · ${grouped}명`],
  ];
  el.windowsSummary.innerHTML = '';
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('span');
    b.textContent = v;
    row.append(a, b);
    // "새 그룹" belongs beside the count it changes, not stranded at the foot
    // of the panel where it reads as being about the whole panel.
    if (k === '그룹') {
      row.classList.add('with-action');
      el.groupNew.hidden = false;
      // 값이 아니라 '그룹' 글자 바로 옆에. 맨 오른쪽에 두면 무엇에 대한
      // 버튼인지 한 칸 건너 읽어야 한다.
      a.after(el.groupNew);
    }
    el.windowsSummary.appendChild(row);
  }
}

el.groupNew.addEventListener('click', async () => {
  const r = await api('/api/desktop/groups', { method: 'POST', body: { name: '새 그룹' } });
  if (r?.group?.id) setTimeout(() => openGroupModal(r.group.id, el.groupNew), 120);
});

function renderUsage() {
  const u = store.usage;
  if (!u?.limits?.length) {
    el.usage.innerHTML = `<p class="muted">${u?.error ? '한도를 읽지 못했습니다' : '확인 중…'}</p>`;
    return;
  }
  el.usage.innerHTML = '';
  for (const lim of u.limits) {
    const cls = lim.leftPercent <= 10 ? 'bad' : lim.leftPercent <= 30 ? 'warn' : '';
    const d = document.createElement('div');
    d.className = 'lim';
    d.innerHTML = `
      <div class="top"><span></span><span></span></div>
      <div class="bar ${cls}"><i></i></div>
      <div class="resets"></div>`;
    d.querySelectorAll('.top span')[0].textContent = lim.label;
    d.querySelectorAll('.top span')[1].textContent = `${Math.round(lim.leftPercent)}% 남음`;
    d.querySelector('.bar > i').style.width = `${lim.leftPercent}%`;
    d.querySelector('.resets').textContent = lim.resets ? `초기화 ${lim.resets}` : '';
    el.usage.appendChild(d);
  }
}

function renderApprovals() {
  const list = store.approvals ?? [];
  el.approvalsPanel.hidden = list.length === 0;
  el.approvals.innerHTML = '';
  for (const a of list) {
    const person = store.crew.find((p) => p.id === a.personId);
    const card = document.createElement('div');
    card.className = 'approval';
    card.innerHTML = `<div class="who"></div><div class="what"></div><div class="why"></div><pre></pre>
      <div class="acts"><button class="allow">허용</button><button class="deny">거부</button></div>`;
    card.querySelector('.who').textContent = person ? `${person.name} · ${person.personaLabel}` : '';
    card.querySelector('.what').textContent = a.title;
    // 카드가 드물어진 만큼, 왜 이것만 물어보는지가 카드에 적혀 있어야 한다.
    const why = card.querySelector('.why');
    if (a.why) why.textContent = a.why; else why.remove();
    const pre = card.querySelector('pre');
    if (a.detail) pre.textContent = a.detail; else pre.remove();
    card.querySelector('.allow').addEventListener('click', () => decide(a.id, 'allow'));
    card.querySelector('.deny').addEventListener('click', () => decide(a.id, 'deny'));
    el.approvals.appendChild(card);
  }
}

async function decide(id, decision) {
  await api(`/api/approvals/${id}`, { method: 'POST', body: { decision } });
}

function renderTasks() {
  const { tasks = [], timer } = store.tasks ?? {};
  el.todayPanel.hidden = tasks.length === 0 && !timer;
  el.tasks.innerHTML = '';
  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = `task${timer?.taskName === t.name ? ' running' : ''}`;
    const b = document.createElement('b');
    b.textContent = t.name;
    const s = document.createElement('span');
    s.textContent = t.minutes ? `${t.minutes}분` : '';
    row.append(b, s);
    // A task is the natural name for a group of windows — it is literally the
    // thing you opened them all for.
    row.addEventListener('pointerdown', (e) => startCardDrag(row, {
      kind: 'task', name: t.name, sub: t.minutes ? `${t.minutes}분` : '',
    }, e));
    el.tasks.appendChild(row);
  }
  if (timer) {
    const note = document.createElement('div');
    note.className = 'running-note';
    const mins = Math.ceil((timer.remainingMs ?? 0) / 60000);
    note.textContent = `▶ ${timer.taskName} — ${mins}분 남음`;
    el.tasks.appendChild(note);
  }
}

/**
 * The manual for a piece of work.
 *
 * This is not documentation anybody wrote — it is what the people who have done
 * this job before left behind (`remember()` in the office MCP), plus the last
 * few runs. It is the thing the next person reads instead of being told again,
 * so the user should be able to read it too, and correct their own mental model
 * of what the office has learned.
 */
async function openManual(jobName, origin) {
  manualJob = jobName;
  el.manualTitle.textContent = jobName;
  el.manualSub.textContent = '불러오는 중…';
  el.manualBody.innerHTML = '';
  if (origin) { setManualEditing(false); openSheet(el.manual, origin); }

  const job = await api(`/api/jobs/${encodeURIComponent(jobName)}`);
  if (!job || job.error) {
    el.manualSub.textContent = '';
    el.manualBody.innerHTML = '<p class="muted">아직 남은 기록이 없습니다.</p>';
    el.manualEdit.value = '';
    return;
  }

  const bits = [`${job.runCount ?? 0}회`];
  if (job.avgMinutes) bits.push(`보통 ${job.avgMinutes}분`);
  if (job.personaKey) bits.push(job.personaKey);
  el.manualSub.textContent = bits.join(' · ');

  el.manualBody.innerHTML = '';
  const section = (title, body, empty) => {
    const h = document.createElement('h4');
    h.textContent = title;
    el.manualBody.appendChild(h);
    if (body?.trim()) el.manualBody.appendChild(renderMarkdown(body));
    else {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = empty;
      el.manualBody.appendChild(p);
    }
  };

  el.manualEdit.value = (job.instructions ?? '').trim();
  section('쌓인 지침', job.instructions, '아직 없습니다 — 이 일을 몇 번 더 하면 채워집니다. 직접 적어 둬도 됩니다.');
  const runs = (job.runs ?? []).map((r) => r.body ?? r.summary ?? '').filter(Boolean);
  if (runs.length) section('최근 실행', runs.join('\n\n---\n\n'), '');
}

/**
 * Reading the manual, or rewriting it.
 *
 * What accumulates here is written by sessions as they go — a rough draft that
 * is sometimes wrong and is handed to every future person verbatim. So it has
 * to be correctable by hand, in the same place you read it.
 */
let manualJob = null;

function setManualEditing(on) {
  el.manualBody.hidden = on;
  el.manualEdit.hidden = !on;
  el.manualSave.hidden = !on;
  el.manualEditor.textContent = on ? '읽기로' : '지침 고치기';
  if (on) el.manualEdit.focus();
}

el.manualEditor.addEventListener('click', () => setManualEditing(el.manualEdit.hidden));

el.manualSave.addEventListener('click', async () => {
  if (!manualJob) return;
  el.manualSave.disabled = true;
  const r = await api(`/api/jobs/${encodeURIComponent(manualJob)}/instructions`, {
    method: 'POST', body: { body: el.manualEdit.value },
  });
  el.manualSave.disabled = false;
  if (r?.ok) { await openManual(manualJob); setManualEditing(false); }
});

el.manualClose.addEventListener('click', () => closeSheet(el.manual));
el.manual.addEventListener('click', (e) => { if (e.target === el.manual) closeSheet(el.manual); });

// ── groups ───────────────────────────────────────────────────────────────
/**
 * One group, opened up.
 *
 * A group on the floor is a ring of little people around a table — legible at a
 * glance, useless for "wait, which five windows are these?". This is that
 * answer, plus the two things you would want next: name it after the work, or
 * keep it for a day when none of it is open.
 */
let openGroupId = null;

function groupMembers(id) {
  return (store.desktop?.people ?? []).filter((p) => p.groupId === id);
}

function openGroupModal(id, origin) {
  const group = (store.groups ?? []).find((g) => g.id === id);
  if (!group) return;
  openGroupId = id;
  el.groupTitle.textContent = group.name || '그룹';
  el.groupName.value = group.name ?? '';
  renderGroupMembers();
  openSheet(el.group, origin);
  el.groupName.focus();
  el.groupName.select();
}

function renderGroupMembers() {
  const members = groupMembers(openGroupId);
  el.groupList.innerHTML = '';
  if (!members.length) {
    el.groupList.innerHTML = '<p class="muted">이 그룹에 든 창이 없습니다.</p>';
  }
  for (const m of members) {
    const row = document.createElement('div');
    row.className = 'win-row';
    row.innerHTML = '<i></i><b></b><small></small>';
    row.querySelector('i').textContent = m.app || '창';
    row.querySelector('b').textContent = m.name;
    row.querySelector('small').textContent = m.minimized ? '내려둠' : '';
    row.title = `${m.app} — ${m.name}`;
    row.addEventListener('click', () => api('/api/desktop/focus', { method: 'POST', body: { key: m.key } }));
    el.groupList.appendChild(row);
  }
  const saved = (store.savedGroups ?? []).find((s) => s.fromGroupId === openGroupId);
  el.groupNote.textContent = saved
    ? `${new Date(saved.savedAt).toLocaleString('ko-KR')} 에 저장해 뒀습니다 — 다시 저장하면 지금 상태로 바뀝니다.`
    : '저장해 두면 창을 다 닫은 뒤에도 이 목록 그대로 다시 열 수 있습니다.';
}

el.groupClose.addEventListener('click', () => closeSheet(el.group));
el.group.addEventListener('click', (e) => { if (e.target === el.group) closeSheet(el.group); });

// The name is the work this group is for, so it is saved as you leave the field
// rather than behind a button you might not press.
el.groupName.addEventListener('change', () => {
  if (!openGroupId) return;
  const name = el.groupName.value.trim();
  if (!name) return;
  api(`/api/desktop/groups/${openGroupId}`, { method: 'POST', body: { name } });
});

el.groupDelete.addEventListener('click', async () => {
  if (!openGroupId) return;
  await api(`/api/desktop/groups/${openGroupId}`, { method: 'DELETE' });
  closeSheet(el.group);
  openGroupId = null;
});

el.groupSave.addEventListener('click', async () => {
  if (!openGroupId) return;
  el.groupSave.disabled = true;
  el.groupSave.textContent = '읽는 중…';
  // The addresses are read HERE, once — see savedGroups.js on why not on a timer.
  const r = await api(`/api/desktop/groups/${openGroupId}/save`, {
    method: 'POST', body: { name: el.groupName.value.trim() },
  });
  el.groupSave.disabled = false;
  el.groupSave.textContent = '저장하기';
  if (r?.ok) closeSheet(el.group);
});

// ── saved groups ─────────────────────────────────────────────────────────
// ── 클로드 계정 ──────────────────────────────────────────────────────────
/**
 * 로그인돼 있으면 누구인지가 버튼에 적히고, 누르면 로그아웃한다.
 * 안 돼 있으면 "로그인" 이 적히고, 누르면 로그인 창이 뜬다.
 *
 * 한 자리에 두 가지 일을 두는 것은 이게 늘 **지금 상태**를 말해 주기
 * 때문이다 — 버튼 두 개를 나란히 두면 어느 쪽이 지금인지 알 수 없다.
 */
function renderAuth() {
  const a = store.tools?.auth;
  const btn = el.authBtn;
  if (!a || a.loggedIn === null) {           // 아직 확인 전
    btn.textContent = '계정';
    btn.title = '클로드 계정 확인 중…';
    return;
  }
  if (a.loggedIn) {
    // 이메일은 길다. 버튼에는 앞부분만, 전체는 툴팁에.
    const who = (a.email || '로그인됨').split('@')[0];
    btn.textContent = who.length > 12 ? `${who.slice(0, 12)}…` : who;
    btn.title = `${a.email}${a.plan ? ` · ${a.plan}` : ''} — 눌러서 로그아웃`;
    btn.classList.remove('warn');
  } else {
    btn.textContent = '로그인';
    btn.title = '클로드에 로그인합니다';
    btn.classList.add('warn');
  }
}

el.authBtn.addEventListener('click', async () => {
  const a = store.tools?.auth;
  el.authBtn.disabled = true;
  try {
    if (a?.loggedIn) {
      if (!confirm(`${a.email || '클로드'} 에서 로그아웃할까요?\n일하고 있는 사람들이 모두 멈춥니다.`)) return;
      const r = await api('/api/auth', { method: 'POST', body: { action: 'logout' } });
      if (!r.ok) alert(r.error ?? '로그아웃하지 못했습니다.');
      if (r.auth) { store.tools = { ...store.tools, auth: r.auth }; renderAuth(); }
    } else {
      const r = await api('/api/auth', { method: 'POST', body: { action: 'login' } });
      // 창이 뜨지도 못했으면 기다릴 것이 없다. 예전에는 이 경우에도 3분을
      // 말없이 기다렸고, 사람은 창이 깜빡였다는 것 말고는 아무것도 못 봤다.
      if (!r.ok) { alert(r.error ?? '로그인 창을 열지 못했습니다.'); return; }
      el.authBtn.textContent = '로그인 중…';
      // 그 창은 claude 가 하는 말을 그대로 보여 준다 — 영어다. 무엇을 해야
      // 하는지는 여기서 한국어로 말해 준다.
      alert('새로 열린 검은 창에서 로그인을 마쳐 주세요.\n브라우저가 열리면 계정을 고르고, 끝나면 그 창은 닫으셔도 됩니다.');
      // 로그인은 딴 창에서 사람이 끝낸다. 끝났는지는 물어봐야 안다.
      const done = await pollAuth();
      if (!done) alert('아직 로그인이 확인되지 않았습니다.\n그 창에 적힌 내용을 확인하고 다시 눌러 주세요.');
    }
  } finally {
    el.authBtn.disabled = false;
    renderAuth();
  }
});

/** 로그인 창이 끝날 때까지 상태를 물어본다. */
async function pollAuth(timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => { setTimeout(r, 3000); });
    const a = await api('/api/auth');
    store.tools = { ...store.tools, auth: a };
    if (a.loggedIn) return true;
  }
  return false;
}

// ── 제목 옆 도움말 ───────────────────────────────────────────────────────
/**
 * 설명을 늘 펼쳐 두면 패널의 절반이 안내문이 된다. 처음 한 번 읽고 나면 다시는
 * 안 읽는 글이므로 ? 뒤로 접었다.
 *
 * 말풍선은 패널 안이 아니라 화면에 띄운다 — 상태 띠는 넘치는 것을 잘라내게 돼
 * 있어서(카드 메뉴에서 같은 데 걸렸다) 패널 안에 두면 긴 설명이 잘린다.
 */
let helpTip = null;

function hideHelp() {
  helpTip?.remove();
  helpTip = null;
}

/** 말풍선을 지금 버튼 자리에 맞춘다. 버튼이 사라졌으면 말풍선도 거둔다. */
function placeHelp() {
  const btn = helpTip?.anchor;
  if (!btn?.isConnected) return hideHelp();
  const r = btn.getBoundingClientRect();
  const w = helpTip.offsetWidth;
  // 화면 끝에 붙은 패널이면 말풍선이 밖으로 나간다 — 안쪽으로 당긴다.
  helpTip.style.left = `${Math.round(Math.max(6, Math.min(r.left - 6, window.innerWidth - w - 6)))}px`;
  // 아래가 좁으면 버튼 위로 올린다.
  const below = r.bottom + 6;
  helpTip.style.top = below + helpTip.offsetHeight > window.innerHeight - 6
    ? `${Math.round(Math.max(6, r.top - helpTip.offsetHeight - 6))}px`
    : `${Math.round(below)}px`;
  return undefined;
}

function showHelp(btn) {
  if (helpTip?.anchor === btn) return;
  hideHelp();
  const text = btn.dataset.help;
  if (!text) return;
  const tip = document.createElement('div');
  tip.className = 'help-tip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  tip.anchor = btn;
  document.body.appendChild(tip);
  helpTip = tip;
  placeHelp();
}

// 위임: 패널은 나타났다 사라졌다 하므로 버튼마다 매다는 것은 의미가 없다.
document.addEventListener('pointerover', (e) => {
  const btn = e.target.closest?.('.help');
  if (btn) showHelp(btn);
  else if (helpTip && !e.target.closest?.('.help-tip')) hideHelp();
});
document.addEventListener('focusin', (e) => {
  const btn = e.target.closest?.('.help');
  if (btn) showHelp(btn);
});
document.addEventListener('focusout', (e) => { if (e.target.closest?.('.help')) hideHelp(); });
// 손가락으로는 hover 가 없다 — 눌러도 보이게.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.help');
  if (btn) { e.preventDefault(); showHelp(btn); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });
// 상태 띠는 가로로 스크롤된다. 그때 말풍선을 지우면, 버튼을 겨누느라 띠가
// 조금 밀리기만 해도 설명이 사라진다 — 지우지 말고 따라가게 한다.
window.addEventListener('resize', placeHelp);
document.addEventListener('scroll', placeHelp, true);

// ── 카드 안의 ⋯ 메뉴 ─────────────────────────────────────────────────────
/**
 * 카드 오른쪽 끝의 점 셋. 지금은 "지우기" 하나뿐이지만, 카드를 누르는 것과
 * 카드에 손대는 것을 갈라 두는 자리다.
 *
 * 카드 자체가 이미 제스처를 갖고 있다 — 일 카드는 눌러서 끌고, 저장된 그룹은
 * 눌러서 연다. 그래서 이 버튼은 pointerdown 부터 막아야 한다. click 만 막으면
 * 드래그는 이미 시작된 뒤다.
 */
let openMenu = null;

function closeCardMenu() {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeCardMenu();
}, true);
// 화면에 띄워 둔 메뉴는 카드를 따라다니지 않는다. 카드가 움직이면 닫는 게 맞다.
window.addEventListener('resize', closeCardMenu);
document.addEventListener('scroll', closeCardMenu, true);

function cardMenu({ label, onDelete }) {
  const wrap = document.createElement('div');
  wrap.className = 'card-menu';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-menu__dots';
  // 점 셋을 글자(⋯)로 쓰면 이 폰트에서 물결선처럼 뭉개진다. 픽셀 화면이니
  // 네모 세 개를 CSS 로 직접 찍는다 (.card-menu__dots::before).
  btn.title = '더 보기';
  btn.setAttribute('aria-label', `${label} 더 보기`);

  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  btn.addEventListener('pointerdown', stop);
  btn.addEventListener('click', (e) => {
    stop(e);
    const mine = openMenu?.dataset.owner === label;
    closeCardMenu();
    if (mine) return; // 같은 걸 다시 누르면 닫기

    const pop = document.createElement('div');
    pop.className = 'card-menu__pop';
    pop.dataset.owner = label;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'card-menu__item danger';
    del.textContent = '지우기';
    del.addEventListener('pointerdown', stop);
    del.addEventListener('click', async (ev) => {
      stop(ev);
      closeCardMenu();
      await onDelete();
    });
    pop.appendChild(del);
    pop.addEventListener('pointerdown', (ev) => ev.stopPropagation());

    // 카드 안에 두면 패널이 잘라 버린다 — 상태 띠는 넘치는 것을 감추게 돼 있어서
    // 메뉴가 카드 밖으로 나가는 순간 반이 사라진다. 그래서 화면 맨 위에 띄우고
    // 버튼 위치에 맞춰 놓는다.
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    // 오른쪽 끝에 붙은 카드면 메뉴가 창 밖으로 나간다 — 안쪽으로 당긴다.
    const w = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6)))}px`;
    openMenu = pop;
  });

  wrap.appendChild(btn);
  return wrap;
}

function savedCard(g, { compact = true } = {}) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.innerHTML = '<b></b><small></small>';
  card.querySelector('b').textContent = g.name;
  const apps = [...new Set(g.items.map((i) => i.app).filter(Boolean))].slice(0, 3).join(', ');
  card.querySelector('small').textContent = compact
    ? `창 ${g.items.length}개${apps ? ` · ${apps}` : ''}`
    : `창 ${g.items.length}개 · ${new Date(g.savedAt).toLocaleDateString('ko-KR')}${apps ? ` · ${apps}` : ''}`;
  card.title = g.items.map((i) => `${i.app} — ${i.title}`).join('\n');
  card.addEventListener('click', async () => {
    card.querySelector('small').textContent = '여는 중…';
    const r = await api(`/api/saved-groups/${g.id}/open`, { method: 'POST' });
    card.querySelector('small').textContent = r?.count
      ? `${r.count}개 열었습니다`
      : '이미 다 열려 있습니다';
    setTimeout(renderSavedGroups, 2500);
  });
  card.appendChild(cardMenu({
    label: g.name,
    onDelete: async () => {
      if (!confirm(`저장된 그룹 "${g.name}" 을(를) 지울까요?\n지금 열려 있는 창은 그대로 둡니다.`)) return;
      await api(`/api/saved-groups/${g.id}`, { method: 'DELETE' });
      const fresh = await api('/api/saved-groups');
      store.savedGroups = fresh.groups ?? [];
      renderSavedGroups();
      // 전체 보기를 열어 둔 채 지웠으면 그쪽도 같이 줄어야 한다.
      if (!el.savedListModal.hidden) fillSavedAll();
    },
  }));
  return card;
}

function renderSavedGroups() {
  const list = store.savedGroups ?? [];
  el.savedPanel.hidden = list.length === 0;
  el.savedAllBtn.hidden = list.length <= 3;
  el.saved.innerHTML = '';
  // Three is what fits without the panel becoming a list to scroll; the rest
  // are one click away rather than gone.
  for (const g of list.slice(0, 3)) el.saved.appendChild(savedCard(g));
}

// 지우기는 카드 안 ⋯ 메뉴로 옮겼다 — 목록에서든 전체 보기에서든 같은 자리다.
function fillSavedAll() {
  el.savedAllList.innerHTML = '';
  for (const g of store.savedGroups ?? []) {
    const row = document.createElement('div');
    row.className = 'saved-row';
    row.appendChild(savedCard(g, { compact: false }));
    el.savedAllList.appendChild(row);
  }
}

el.savedAllBtn.addEventListener('click', (e) => {
  fillSavedAll();
  openSheet(el.savedListModal, e.currentTarget);
});
el.savedListClose.addEventListener('click', () => closeSheet(el.savedListModal));
el.savedListModal.addEventListener('click', (e) => {
  if (e.target === el.savedListModal) closeSheet(el.savedListModal);
});

function renderJobs() {
  // A job only becomes a card once it has been done at least once; a one-off
  // isn't a habit worth offering.
  const list = (store.jobs ?? []).filter((j) => j.runCount >= 1);
  el.jobsPanel.hidden = list.length === 0;
  el.jobs.innerHTML = '';
  for (const j of list) {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = '<b></b><small></small>';
    card.querySelector('b').textContent = j.name;
    const sub = `${j.runCount}회${j.avgMinutes ? ` · 보통 ${j.avgMinutes}분` : ''}`;
    card.querySelector('small').textContent = sub;
    card.addEventListener('pointerdown', (e) => startCardDrag(card, {
      kind: 'job', name: j.name, sub,
    }, e, () => openManual(j.name, card)));
    card.appendChild(cardMenu({
      label: j.name,
      onDelete: async () => {
        // 카드만 없어지는 게 아니라 그동안 쌓인 지침과 실행 기록이 같이 간다.
        if (!confirm(`"${j.name}" 을(를) 목록에서 지울까요?\n지금까지 쌓인 지침 ${j.runCount}회분도 같이 없어집니다.`)) return;
        await api(`/api/jobs/${encodeURIComponent(j.slug ?? j.name)}`, { method: 'DELETE' });
        const fresh = await api('/api/jobs');
        store.jobs = fresh.jobs ?? [];
        renderJobs();
      },
    }));
    el.jobs.appendChild(card);
  }
}

/**
 * Handing a card to someone is a physical act, so it is a pointer gesture rather
 * than HTML5 drag-and-drop — that API reports a drop and nothing in between,
 * which is exactly the continuous feedback this needs.
 *
 * The card leaves a dimmed copy of itself behind, the one in the air stays glued
 * to the point you grabbed it by, leans into the direction it is moving, and on
 * release either lands on its target (its momentum projected, so a flick counts)
 * or springs home carrying the velocity your hand gave it.
 *
 * Where it can land depends on what it is:
 *   일 카드   → a person (they pick the job up), or a table (it names the group)
 *   할 일     → a table, or empty floor in the windows zone (a new group)
 *
 * @param {{kind:'job'|'task', name:string, sub:string}} item
 */
function startCardDrag(card, item, down, onTap) {
  if (down.button !== 0) return;
  const origin = card.getBoundingClientRect();
  const grab = { x: down.clientX - origin.left, y: down.clientY - origin.top };
  const track = new VelocityTracker();
  track.add(down.clientX, down.clientY);

  let ghost = null;
  let pos = { x: origin.left, y: origin.top };
  let tilt = 0;
  let hovered = null;
  card.setPointerCapture(down.pointerId);

  const paint = (scale = 1.04) => {
    ghost.style.transform =
      `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${tilt.toFixed(2)}deg) scale(${scale})`;
  };

  const lift = () => {
    ghost = document.createElement('div');
    ghost.className = 'job-ghost';
    ghost.innerHTML = '<b></b><small></small>';
    ghost.querySelector('b').textContent = item.name;
    ghost.querySelector('small').textContent = item.sub;
    ghost.style.minWidth = `${origin.width}px`;
    el.dragLayer.appendChild(ghost);
    card.classList.add('lifted');
    el.stage.classList.add('drop-target');
    paint();
  };

  /** Where this card would land right now — or null if nowhere. */
  const targetAt = (x, y) => {
    const hit = office.hitAtClient(x, y);
    if (!hit) return null;
    if (hit.kind === 'seat' && hit.person && item.kind === 'job') return hit;
    if (hit.kind === 'pod') return hit;
    if (hit.kind === 'zone') return hit;
    return null;
  };

  const setHover = (hit) => {
    const id = hit?.kind === 'seat' ? hit.person.id : hit?.groupId ?? null;
    if (hovered === id) return;
    if (hovered) office.plates.get(hovered)?.classList.remove('drop');
    office.dropHint = null;
    hovered = id;
    if (hit?.kind === 'seat') office.plates.get(id)?.classList.add('drop');
    else if (hit?.kind === 'pod') office.dropHint = id;
  };

  const onMove = (e) => {
    track.add(e.clientX, e.clientY);
    if (!ghost) {
      // ~8px of hysteresis: a press that never really moved is not a drag.
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 8) return;
      lift();
    }
    pos = { x: e.clientX - grab.x, y: e.clientY - grab.y }; // keeps the grab offset
    // Lean toward where it is going — the in-between frames should tell you
    // where this is headed.
    const want = Math.max(-6, Math.min(6, track.get().x / 130));
    tilt += (want - tilt) * 0.25;
    paint();
    setHover(targetAt(e.clientX, e.clientY));
  };

  const onUp = (e) => {
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onUp);
    el.stage.classList.remove('drop-target');
    setHover(null);
    if (!ghost) { onTap?.(); return; } // a tap, not a throw

    const v = track.get();
    // Where the card would come to rest if you let it slide — a flick toward
    // someone counts as handing it to them. 0.99 rather than the scroll-view
    // 0.998: across a few hundred pixels the slower rate throws the card most
    // of the way across the screen, which is not what the hand meant.
    const landing = { x: e.clientX + project(v.x, 0.99), y: e.clientY + project(v.y, 0.99) };
    const hit = targetAt(e.clientX, e.clientY) ?? targetAt(landing.x, landing.y);

    if (hit) handOff(hit, v);
    else springHome(v);
  };

  // The work starts the moment you let go; the animation is only how it looks.
  function handOff(hit, v) {
    if (hit.kind === 'seat') {
      api(`/api/crew/${hit.person.id}/job`, { method: 'POST', body: { jobName: item.name } });
      select(hit.person.id);
    } else if (hit.kind === 'pod') {
      // Naming an existing table after this piece of work.
      api(`/api/desktop/groups/${hit.groupId}`, { method: 'POST', body: { name: item.name } });
    } else {
      api('/api/desktop/groups', { method: 'POST', body: { name: item.name } });
    }

    const r = office.canvas.getBoundingClientRect();
    const target = {
      x: r.left + (hit.x + hit.w / 2) * office.scale - ghost.offsetWidth / 2,
      y: r.top + (hit.y + hit.h / 2) * office.scale - ghost.offsetHeight / 2,
    };
    let shrink = 1.04;
    spring({
      from: 1.04, to: 0.6, duration: 0.32, bounce: 0,
      onUpdate: (s) => { shrink = s; },
    });
    ghost.style.transition = 'opacity 260ms ease-out';
    ghost.style.opacity = '0';
    spring2d({
      from: pos, to: target, velocity: v, duration: 0.4, bounce: 0, // a move: no overshoot
      onUpdate: (p) => { pos = p; tilt *= 0.9; paint(shrink); },
      onDone: cleanup,
    });
  }

  function springHome(v) {
    // The list can re-render mid-drag (a job finishes, the card is replaced).
    // With nowhere to land, the ghost fades out where it is rather than
    // springing to the top-left corner of the screen.
    if (!card.isConnected) {
      ghost.style.transition = 'opacity 200ms ease-out';
      ghost.style.opacity = '0';
      setTimeout(cleanup, 220);
      return;
    }
    const home = card.getBoundingClientRect(); // re-measured: the list may have moved
    let scale = 1.04;
    spring({ from: 1.04, to: 1, duration: 0.4, bounce: 0.2, onUpdate: (s) => { scale = s; } });
    spring2d({
      // Bounce, because your hand put momentum into it — a card that just
      // faded in would have no business overshooting.
      from: pos, to: { x: home.left, y: home.top }, velocity: v, duration: 0.4, bounce: 0.2,
      onUpdate: (p) => { pos = p; tilt *= 0.88; paint(scale); },
      onDone: cleanup,
    });
  }

  function cleanup() {
    ghost?.remove();
    ghost = null;
    office.dropHint = null;
    card.classList.remove('lifted');
  }

  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);
}

function renderActivity() {
  const list = store.activity.slice(-60).reverse();
  el.activity.innerHTML = '';
  for (const a of list) {
    const li = document.createElement('li');
    li.dataset.kind = a.kind;
    const t = document.createElement('time');
    t.textContent = new Date(a.ts).toTimeString().slice(0, 5);
    const span = document.createElement('span');
    span.textContent = a.text;
    li.append(t, span);
    el.activity.appendChild(li);
  }
}

// ── self update ──────────────────────────────────────────────────────────
let updateDismissed = false;

function renderUpdate() {
  const u = store.update;

  /**
   * 클로드를 못 찾는 것이 무엇보다 먼저다.
   *
   * 그 상태에서는 세션이 뜨자마자 죽어 "종료됨" 으로 보이고 남은 한도 칸이
   * 비는데, 쓰는 사람 눈에는 로그아웃된 것처럼 보인다. 원인을 화면이 직접
   * 말해 주지 않으면 알아낼 방법이 없다.
   */
  if (store.tools && !store.tools.claude?.found) {
    el.updateBar.hidden = false;
    el.updateApply.hidden = true;
    el.updateHide.hidden = true;
    el.updateText.textContent = 'Claude Code 를 찾지 못했습니다 — 그래서 사람을 불러도 바로 종료되고 '
      + '남은 한도도 안 보입니다. PowerShell 에서 설치 한 줄을 다시 실행해 주세요.';
    return;
  }
  el.updateApply.hidden = false;
  el.updateHide.hidden = false;

  // git 이 없으면 자동 갱신 자체가 불가능하다. 조용히 아무 일도 안 하는 대신
  // 그렇다고 말한다 — 예전에는 이 경우 띠가 영영 안 떠서, 새 버전을 내도
  // 받는 쪽은 아무것도 모르고 있었다.
  if (u && !u.git) {
    el.updateBar.hidden = updateDismissed;
    el.updateApply.hidden = true;
    el.updateText.textContent = '이 설치본은 자동 업데이트를 못 받습니다(git 없이 받은 압축본). '
      + '새 버전을 받으려면 설치 한 줄을 다시 실행해 주세요.';
    return;
  }

  el.updateBar.hidden = !u?.behind || updateDismissed;
  if (el.updateBar.hidden) return;
  // 알아서 받는 설정이면 이 띠는 "지금 일하는 사람이 있어서 기다리는 중" 일
  // 때만 보인다 — 아무도 안 하고 있으면 눌러 볼 새도 없이 지나가기 때문이다.
  // 그러니 재촉이 아니라 사정 설명이어야 한다.
  el.updateText.textContent = u?.auto
    ? '새 버전이 있습니다. 지금 일하는 사람이 있어 끝나면 알아서 받습니다 — '
      + '지금 바로 받으려면 받기를 누르세요. 앉아 있는 사람들은 나눈 대화 그대로 돌아옵니다.'
    : '새 버전이 있습니다. 받기를 누르면 받아서 자동으로 다시 시작합니다 — '
      + '앉아 있는 사람들은 나눈 대화 그대로 자리로 돌아옵니다.';
}

el.updateHide.addEventListener('click', () => { updateDismissed = true; renderUpdate(); });

el.updateApply.addEventListener('click', async () => {
  /*
   * 받기는 앱을 다시 켠다. 이제 앉아 있는 사람들은 나눈 대화를 그대로 들고
   * 자리로 돌아오지만(crew.revive), **지금 돌고 있는 턴**은 거기서 끊긴다 —
   * 쓰던 파일은 쓰다 만 채로 남는다. 그래서 일하는 사람이 있을 때만 묻는다.
   */
  const busy = store.crew.filter((p) => p.state === 'working' || p.state === 'starting');
  if (busy.length) {
    const who = busy.map((p) => p.name).slice(0, 4).join(', ');
    const ok = confirm(
      `지금 ${busy.length}명이 일하는 중입니다 (${who}${busy.length > 4 ? ' 외' : ''}).\n\n`
      + '받으면 앱이 다시 시작합니다. 이 사람들은 나눈 대화 그대로 자리로 돌아와서\n'
      + '하던 일을 이어서 합니다 — 다만 지금 돌고 있는 것은 중간에 한 번 끊깁니다.\n\n'
      + '지금 받을까요? (일이 끝난 뒤에 눌러도 됩니다)',
    );
    if (!ok) return;
  }
  el.updateApply.disabled = true;
  el.updateText.textContent = '받는 중…';
  const r = await api('/api/update', { method: 'POST' });
  if (!r.ok) {
    el.updateApply.disabled = false;
    el.updateText.textContent = r.error ?? '업데이트하지 못했습니다.';
    return;
  }
  el.updateApply.hidden = true;
  if (!r.restarting) {
    el.updateText.textContent = '받았습니다. 바탕화면 아이콘으로 다시 시작하면 적용됩니다.';
    return;
  }
  // 앱이 스스로 다시 켜는 중이다. 예전에는 여기서 "다시 시작하세요" 라고만
  // 하고 끝냈는데, 그 말을 따르지 않으면 화면은 그대로라 받은 사람 눈에는
  // 업데이트가 안 된 것으로 보였다. 서버가 돌아오면 우리가 새로고침한다.
  el.updateText.textContent = '다시 시작하는 중… 잠시만요.';
  await waitForServer();
  location.reload();
});

/** 서버가 다시 뜰 때까지. 못 뜨면 사람이 아이콘으로 켤 수 있게 말해 준다. */
async function waitForServer(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  // 먼저 죽는 것을 기다린다 — 아직 살아 있는 옛 프로세스를 보고 곧장
  // 새로고침하면 옛 코드를 다시 받는다.
  await new Promise((r) => { setTimeout(r, 2500); });
  while (Date.now() < until) {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (res.ok) return true;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  el.updateText.textContent = '다시 시작하지 못했습니다. 바탕화면 아이콘으로 열어 주세요.';
  return false;
}

function renderAll() {
  renderUpdate();
  renderAuth();
  renderCrew();
  renderUsage();
  renderActivity();
  renderApprovals();
  renderTasks();
  renderJobs();
  renderSavedGroups();
  renderWindows();
  renderChat();
}
window.__render = renderAll; // handy for the Playwright checks

// ── the status strip's height ────────────────────────────────────────────
/**
 * How much of the left side the status panels get, and how much is left for the
 * room. Same shape as the chat-width handle — including listening on the window
 * rather than the handle, for the same reason.
 */
const DECK_KEY = 'crew.deckHeight';
const deckResizer = document.getElementById('deck-resize');

function clampDeck(px) {
  // The room must keep the larger share; below ~120px the panels are unreadable.
  const max = Math.max(160, Math.round(window.innerHeight * 0.52));
  return Math.round(Math.max(120, Math.min(max, px)));
}

function setDeckHeight(px, { save = true } = {}) {
  const h = clampDeck(px);
  app.style.setProperty('--deck-h', `${h}px`);
  deckResizer.setAttribute('aria-valuenow', String(h));
  if (save) { try { localStorage.setItem(DECK_KEY, String(h)); } catch { /* private mode */ } }
  return h;
}

function currentDeckHeight() {
  return document.querySelector('.deck-wrap').getBoundingClientRect().height;
}

function clearDeckHeight() {
  app.style.removeProperty('--deck-h');
  deckResizer.removeAttribute('aria-valuenow');
  try { localStorage.removeItem(DECK_KEY); } catch { /* private mode */ }
}

(function restoreDeckHeight() {
  let saved = null;
  try { saved = localStorage.getItem(DECK_KEY); } catch { /* private mode */ }
  if (saved) setDeckHeight(Number(saved), { save: false });
})();

deckResizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const id = e.pointerId;
  try { deckResizer.setPointerCapture(id); } catch { /* capture is a nicety */ }
  deckResizer.classList.add('dragging');
  document.body.classList.add('resizing-v');

  // Measured from the bottom of the window, which is where this band ends.
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    setDeckHeight(document.documentElement.clientHeight - ev.clientY, { save: false });
  };
  const up = (ev) => {
    if (ev && ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    deckResizer.classList.remove('dragging');
    document.body.classList.remove('resizing-v');
    setDeckHeight(currentDeckHeight());
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

deckResizer.addEventListener('dblclick', clearDeckHeight);
deckResizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 48 : 12;
  if (e.key === 'ArrowUp') setDeckHeight(currentDeckHeight() + step);
  else if (e.key === 'ArrowDown') setDeckHeight(currentDeckHeight() - step);
  else if (e.key === 'Home' || e.key === 'Escape') clearDeckHeight();
  else return;
  e.preventDefault();
});

// ── how wide each status panel is ────────────────────────────────────────
/**
 * The panels hold different things — a list of today's work needs more room
 * than a pair of progress bars — so each one's width is its own, set by
 * dragging its right edge and remembered from then on.
 *
 * Stored per panel id, so adding a panel later does not disturb the others.
 */
const PANEL_KEY = 'crew.panelWidths';

/**
 * 기준 폭은 창을 따라간다.
 *
 * 예전에는 232px 로 못 박아 둬서, 넓은 화면에서는 띠 오른쪽이 남고 좁은
 * 화면에서는 두 칸도 안 들어갔다. 이제 띠가 실제로 가진 너비에서 뽑는다 —
 * 창 크기뿐 아니라 대화창을 넓히고 줄이는 것에도 같이 반응한다.
 *
 * 위아래는 막아 둔다: 좁으면 읽을 수 없고, 넓으면 한 칸이 띠를 다 먹는다.
 */
let lastBase = 0;

function syncPanelBase() {
  const room = el.deck.clientWidth || window.innerWidth;
  const base = Math.round(Math.max(190, Math.min(340, room / 5)));
  // 같은 값을 다시 쓰지 않는다. 이건 el.deck 의 style 속성을 건드리는 일인데,
  // 그 속성을 지켜보는 MutationObserver 가 addPanelGrips 를 다시 부르고 그게
  // 여기로 돌아온다 — 값이 같아도 '속성이 바뀐 것' 으로 쳐서 끝없이 돈다.
  if (base !== lastBase) {
    lastBase = base;
    el.deck.style.setProperty('--panel-base', `${base}px`);
  }
  return base;
}

function panelBase() {
  return lastBase || syncPanelBase();
}

function readPanelScales() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function savePanelScale(id, scale) {
  try {
    const all = readPanelScales();
    if (scale === null) delete all[id];
    else all[id] = Math.round(scale * 1000) / 1000;
    localStorage.setItem(PANEL_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/** Wide enough to read, never so wide it becomes the whole strip. */
function clampPanel(px) {
  return Math.round(Math.max(180, Math.min(760, px)));
}

/**
 * 저장된 값이 px 이면 배수로 옮긴다.
 *
 * 이 설정은 폭(232 같은 수)으로 저장돼 왔다. 그대로 배수로 읽으면 판때기가
 * 232배가 되므로, 사람이 쓰던 값을 버리지 않고 지금 기준으로 환산한다.
 */
function panelScaleOf(saved, base) {
  const v = Number(saved);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v > 20 ? v / base : v;
}

function addPanelGrips() {
  const base = syncPanelBase();
  const saved = readPanelScales();
  for (const panel of document.querySelectorAll('.deck > .panel[id]')) {
    const scale = panelScaleOf(saved[panel.id], base);
    if (scale) {
      panel.style.setProperty('--panel-scale', String(scale));
      // 옛 px 값을 만났으면 배수로 다시 적어 둔다 — 다음부터는 창을 따라간다.
      if (Number(saved[panel.id]) > 20) savePanelScale(panel.id, scale);
    }
    if (panel.querySelector('.panel-grip')) continue;

    const grip = document.createElement('div');
    grip.className = 'panel-grip';
    grip.title = '끌어서 이 칸의 너비 조절 · 더블클릭하면 원래대로';
    panel.appendChild(grip);

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.pointerId;
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      grip.classList.add('dragging');
      document.body.classList.add('resizing');
      try { grip.setPointerCapture(id); } catch { /* capture is a nicety */ }

      // Width from the drag distance, not from the pointer's absolute position:
      // the panel can be scrolled sideways mid-drag, and its left edge moves.
      // 끌어서 정한 폭은 px 가 아니라 기준 대비 배수로 남긴다. 그래야 창을
      // 키웠을 때 내가 넓혀 둔 칸도 같이 넓어진다.
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        panel.style.setProperty('--panel-scale', String(clampPanel(startW + (ev.clientX - startX)) / panelBase()));
      };
      const up = (ev) => {
        if (ev && ev.pointerId !== id) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing');
        savePanelScale(panel.id, clampPanel(panel.getBoundingClientRect().width) / panelBase());
        syncDeckArrows();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      // 인라인 배수만 걷어내면 스타일시트의 기본 배수로 돌아간다.
      panel.style.removeProperty('--panel-scale');
      savePanelScale(panel.id, null);
      syncDeckArrows();
    });
  }
}

// ── the deck's ends ──────────────────────────────────────────────────────
/**
 * The status strip runs wider than the screen, and a horizontal scrollbar in a
 * 200px-tall band is a poor handle. These take you to either end in one press.
 *
 * They only appear when there is somewhere to go, and the strip keeps a gutter
 * at each end (--deck-gutter) so a panel never comes to rest underneath one.
 */
function syncDeckArrows() {
  const d = el.deck;
  const over = d.scrollWidth - d.clientWidth;
  const scrollable = over > 8;
  el.deckPrev.hidden = !scrollable || d.scrollLeft <= 4;
  el.deckNext.hidden = !scrollable || d.scrollLeft >= over - 4;
}

el.deckPrev.addEventListener('click', () => el.deck.scrollTo({ left: 0, behavior: 'smooth' }));
el.deckNext.addEventListener('click', () => el.deck.scrollTo({ left: el.deck.scrollWidth, behavior: 'smooth' }));
el.deck.addEventListener('scroll', syncDeckArrows, { passive: true });
window.addEventListener('resize', () => { syncPanelBase(); syncDeckArrows(); });
// Panels appear and disappear as work arrives, so the strip's width is not
// fixed — watch it rather than checking once. 대화창을 끌어 넓히면 띠도 좁아지고,
// 그때 기준 폭도 같이 따라가야 한다 (창 크기는 그대로이므로 resize 로는 못 안다).
new ResizeObserver(() => { syncPanelBase(); syncDeckArrows(); }).observe(el.deck);
new MutationObserver(() => { addPanelGrips(); syncDeckArrows(); })
  .observe(el.deck, { childList: true, attributes: true, subtree: true });
addPanelGrips();

// ── loop ─────────────────────────────────────────────────────────────────
let last = 0;
function loop(now) {
  // Pixel art at 24fps: any smoother just burns CPU without looking better.
  if (now - last > 41) {
    last = now;
    office.render(now);
  }
  requestAnimationFrame(loop);
}

office.setState(store);
connect();
requestAnimationFrame(loop);
