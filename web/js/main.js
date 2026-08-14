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
  meta: { maxSeats: 4 },
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
  selectedId: null,
};
window.__store = store; // handy for the Playwright checks

const el = {
  office: document.getElementById('office'),
  plates: document.getElementById('nameplates'),
  chat: document.getElementById('chat'),
  chatTitle: document.getElementById('chat-title'),
  composer: document.getElementById('composer'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  dismiss: document.getElementById('dismiss'),
  watch: document.getElementById('watch'),
  trust: document.getElementById('trust'),
  approvals: document.getElementById('approvals'),
  approvalsPanel: document.getElementById('approvals-panel'),
  activity: document.getElementById('activity'),
  usage: document.getElementById('usage'),
  system: document.getElementById('system'),
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
  types: document.getElementById('types'),
  typeTabs: document.getElementById('type-tabs'),
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
};

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
    const name = prompt('새 그룹 이름', '새 그룹');
    if (!name?.trim()) return;
    await api('/api/desktop/groups', { method: 'POST', body: { name: name.trim(), key } });
    return;
  }
  await api('/api/desktop/assign', { method: 'POST', body: { key, groupId: target } });
};
office.onGroupToggle = (id) => api(`/api/desktop/groups/${id}/toggle`, { method: 'POST' });
office.onGroupRename = async (id) => {
  const group = store.groups.find((g) => g.id === id);
  const name = prompt('그룹 이름 (비우면 그룹을 없앱니다)', group?.name ?? '');
  if (name === null) return;
  if (!name.trim()) {
    await api(`/api/desktop/groups/${id}`, { method: 'DELETE' });
    return;
  }
  await api(`/api/desktop/groups/${id}`, { method: 'POST', body: { name: name.trim() } });
};

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
    });
    el.version.textContent = `v${s.meta?.version ?? ''}`;
    renderAll();
  });

  es.addEventListener('crew', (e) => { store.crew = JSON.parse(e.data); renderCrew(); });
  es.addEventListener('update', (e) => { store.update = JSON.parse(e.data); renderUpdate(); });
  es.addEventListener('approvals', (e) => { store.approvals = JSON.parse(e.data); renderApprovals(); });
  es.addEventListener('desktop', (e) => { store.desktop = JSON.parse(e.data); renderWindows(); });
  es.addEventListener('groups', (e) => { store.groups = JSON.parse(e.data); renderWindows(); });
  es.addEventListener('jobs', (e) => { store.jobs = JSON.parse(e.data); renderJobs(); });
  es.addEventListener('tasks', (e) => { store.tasks = JSON.parse(e.data); renderTasks(); });
  es.addEventListener('personas', (e) => { store.personas = JSON.parse(e.data); });
  es.addEventListener('system', (e) => { store.system = JSON.parse(e.data); renderSystem(); });
  es.addEventListener('usage', (e) => { store.usage = JSON.parse(e.data); renderUsage(); });

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

  el.chatTitle.textContent = `${person.name} · ${person.personaLabel}`;
  el.composer.hidden = false;
  el.watch.checked = !!person.watch;
  el.trust.checked = !!person.trusted;

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
  const files = await uploadPending(person.id);
  await api(`/api/crew/${person.id}/send`, { method: 'POST', body: { text, files } });
  el.send.disabled = false;
  el.prompt.focus();
});

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

el.trust.addEventListener('change', async () => {
  const person = selectedPerson();
  if (!person) return;
  await api(`/api/crew/${person.id}/trust`, { method: 'POST', body: { on: el.trust.checked } });
});

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
    text.innerHTML = `<b></b><small></small>`;
    text.querySelector('b').textContent = p.label;
    text.querySelector('small').textContent = p.blurb || '';

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

el.files.addEventListener('change', () => {
  pending = [...el.files.files];
  el.files.value = '';
  renderAttachments();
});

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
 * Base64 over JSON rather than multipart: this is localhost, the files are the
 * kind a person hands a colleague, and it saves hand-rolling a multipart parser
 * in a zero-dependency server.
 */
async function uploadPending(personId) {
  if (!pending.length) return [];
  const files = await Promise.all(pending.map(async (f) => ({
    name: f.name,
    data: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))),
  })));
  const out = await api(`/api/crew/${personId}/files`, { method: 'POST', body: { files } });
  pending = [];
  renderAttachments();
  return out.files ?? [];
}

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

  await api(`/api/personas/${encodeURIComponent(editor.key)}`, {
    method: 'POST', body: { systemPrompt: el.typeSystem.value },
  });
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
  office.setState(store);
  const seated = store.crew.length;
  const leaving = store.crew.some((p) => p.state === 'leaving');
  el.hint.textContent = leaving
    ? '나가는 사람이 이번에 알게 된 것을 정리하는 중입니다.'
    : seated >= (store.meta.maxSeats ?? 4)
      ? '자리가 다 찼습니다. 오른쪽 문으로 한 명 내보내면 새로 부를 수 있습니다.'
      : '빈 책상을 누르면 사람을 부릅니다. 문으로 끌면 내보냅니다.';

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
    el.windowsSummary.appendChild(row);
  }
}

el.groupNew.addEventListener('click', async () => {
  const name = prompt('새 그룹 이름', '새 그룹');
  if (!name?.trim()) return;
  await api('/api/desktop/groups', { method: 'POST', body: { name: name.trim() } });
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
    card.innerHTML = `<div class="who"></div><div class="what"></div><pre></pre>
      <div class="acts"><button class="allow">허용</button><button class="deny">거부</button></div>`;
    card.querySelector('.who').textContent = person ? `${person.name} · ${person.personaLabel}` : '';
    card.querySelector('.what').textContent = a.title;
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
    }, e));
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
function startCardDrag(card, item, down) {
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
    if (!ghost) return; // a tap, not a throw

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

function renderSystem() {
  const s = store.system;
  if (!s) return;
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1)}GB`;
  el.system.innerHTML = `
    <div class="row"><span>CPU</span><span>${s.cpuPercent}%</span></div>
    <div class="row"><span>메모리</span><span>${s.memPercent}% · ${gb(s.memTotal - s.memFree)} / ${gb(s.memTotal)}</span></div>
    <div class="row"><span>자리</span><span>${store.crew.length} / ${store.meta.maxSeats ?? 4}</span></div>`;
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
  el.updateBar.hidden = !u?.behind || updateDismissed;
  if (el.updateBar.hidden) return;
  el.updateText.textContent = '새 버전이 있습니다. 받아서 다시 시작하면 적용됩니다 — 업무 이력과 유형 설정은 그대로 남습니다.';
}

el.updateHide.addEventListener('click', () => { updateDismissed = true; renderUpdate(); });

el.updateApply.addEventListener('click', async () => {
  el.updateApply.disabled = true;
  el.updateText.textContent = '받는 중…';
  const r = await api('/api/update', { method: 'POST' });
  el.updateApply.disabled = false;
  if (r.ok) {
    el.updateText.textContent = '받았습니다. 바탕화면 아이콘으로 다시 시작하면 적용됩니다.';
    el.updateApply.hidden = true;
  } else {
    el.updateText.textContent = r.error ?? '업데이트하지 못했습니다.';
  }
});

function renderAll() {
  renderUpdate();
  renderCrew();
  renderUsage();
  renderSystem();
  renderActivity();
  renderApprovals();
  renderTasks();
  renderJobs();
  renderWindows();
  renderChat();
}
window.__render = renderAll; // handy for the Playwright checks

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

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');

  // Measured from the right edge of the window, which is where this column ends.
  const move = (ev) => setChatWidth(document.documentElement.clientWidth - ev.clientX, { save: false });
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('pointerup', up);
    resizer.removeEventListener('pointercancel', up);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setChatWidth(currentChatWidth()); // one write at the end, not one per pixel
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
  resizer.addEventListener('pointercancel', up);
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
