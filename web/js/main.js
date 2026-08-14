import { Office } from './office.js';
import { avatarOf, character } from './sprites.js';
import { spring, spring2d, project, VelocityTracker } from './motion.js';

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
  meta: { maxSeats: 4 },
  /** personId -> [{role, text, at}] */
  chats: new Map(),
  /** personId -> partial assistant text */
  streaming: new Map(),
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
};

const office = new Office(el.office, el.plates);
window.__office = office;

office.onSeatClick = (seat, at) => openHire(at);
office.onPersonClick = (id) => select(id);

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
      update: s.update,
    });
    el.version.textContent = `v${s.meta?.version ?? ''}`;
    renderAll();
  });

  es.addEventListener('crew', (e) => { store.crew = JSON.parse(e.data); renderCrew(); });
  es.addEventListener('update', (e) => { store.update = JSON.parse(e.data); renderUpdate(); });
  es.addEventListener('approvals', (e) => { store.approvals = JSON.parse(e.data); renderApprovals(); });
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
    if (personId === store.selectedId) renderChat();
  });

  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    // The full message supersedes whatever we accumulated while it streamed.
    // A bubble that was already on screen streaming must not re-enter as if it
    // were new — it just stops being dashed.
    const wasStreaming = store.streaming.has(m.personId);
    if (m.role === 'assistant') store.streaming.delete(m.personId);
    const list = store.chats.get(m.personId) ?? [];
    list.push({ role: m.role, text: m.text, at: m.at, settled: m.role === 'assistant' && wasStreaming });
    store.chats.set(m.personId, list.slice(-200));
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
    store.chats.set(id, (entries ?? []).map(toMessage).filter(Boolean));
  }
  renderChat();
}

function toMessage(entry) {
  if (entry.kind === 'text') return { role: entry.role, text: entry.text, at: entry.at };
  if (entry.kind === 'tool_use') return { role: 'tool', text: `${entry.text} 실행`, at: entry.at };
  return null;
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

  const msgs = store.chats.get(person.id) ?? [];
  const streaming = store.streaming.get(person.id);

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
  if (streaming) el.chat.appendChild(bubbleEl('assistant', streaming, true));
  if (!msgs.length && !streaming) {
    el.chat.innerHTML = '<p class="muted empty">아직 대화가 없습니다.</p>';
  }
  if (atBottom) el.chat.scrollTop = el.chat.scrollHeight;
}

/** personId -> how many messages were already on screen last render */
const shownCount = new Map();

function bubbleEl(role, text, streaming = false, fresh = false) {
  const d = document.createElement('div');
  d.className = `msg ${role}${streaming ? ' streaming' : ''}${fresh ? ' in' : ''}`;
  d.textContent = text;
  return d;
}

el.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.prompt.value.trim();
  const person = selectedPerson();
  if ((!text && !pending.length) || !person) return;
  el.prompt.value = '';
  el.send.disabled = true;
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

el.dismiss.addEventListener('click', async () => {
  const person = selectedPerson();
  if (!person) return;
  await api(`/api/crew/${person.id}`, { method: 'DELETE' });
  store.chats.delete(person.id);
  shownCount.delete(person.id);
  store.selectedId = null;
  office.selectedId = null;
  renderChat();
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
  for (const modal of [el.types, el.hire]) {
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
  el.hint.textContent = seated >= (store.meta.maxSeats ?? 4)
    ? '자리가 다 찼습니다. 한 명 퇴근시키면 새로 부를 수 있습니다.'
    : '빈 책상을 누르면 사람을 부릅니다.';
  if (store.selectedId && !store.crew.some((p) => p.id === store.selectedId)) renderChat();
}

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
    card.querySelector('small').textContent =
      `${j.runCount}회${j.avgMinutes ? ` · 보통 ${j.avgMinutes}분` : ''}`;
    card.addEventListener('pointerdown', (e) => startJobDrag(card, j, e));
    el.jobs.appendChild(card);
  }
}

/**
 * Handing a job to someone is a physical act, so it is a pointer gesture rather
 * than HTML5 drag-and-drop — that API reports a drop and nothing in between,
 * which is exactly the continuous feedback this needs.
 *
 * The card leaves a dimmed copy of itself behind, the one in the air stays glued
 * to the point you grabbed it by, leans into the direction it is moving, and on
 * release either lands on the person (its momentum projected, so a flick counts)
 * or springs home carrying the velocity your hand gave it.
 */
function startJobDrag(card, job, down) {
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
    ghost.querySelector('b').textContent = job.name;
    ghost.querySelector('small').textContent = card.querySelector('small').textContent;
    ghost.style.minWidth = `${origin.width}px`;
    el.dragLayer.appendChild(ghost);
    card.classList.add('lifted');
    el.stage.classList.add('drop-target');
    paint();
  };

  const setHover = (person) => {
    if (hovered === person?.id) return;
    if (hovered) office.plates.get(hovered)?.classList.remove('drop');
    hovered = person?.id ?? null;
    if (hovered) office.plates.get(hovered)?.classList.add('drop');
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
    setHover(office.hitAtClient(e.clientX, e.clientY)?.person ?? null);
  };

  const onUp = (e) => {
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onUp);
    el.stage.classList.remove('drop-target');
    if (!ghost) return; // a tap, not a throw

    const v = track.get();
    // Where the card would come to rest if you let it slide — a flick toward
    // someone counts as handing it to them. 0.99 rather than the scroll-view
    // 0.998: across a few hundred pixels the slower rate throws the card most
    // of the way across the screen, which is not what the hand meant.
    const landing = { x: e.clientX + project(v.x, 0.99), y: e.clientY + project(v.y, 0.99) };
    const hit = office.hitAtClient(e.clientX, e.clientY)?.person
      ? office.hitAtClient(e.clientX, e.clientY)
      : office.hitAtClient(landing.x, landing.y);
    setHover(null);

    if (hit?.person) handOff(hit, v);
    else springHome(v);
  };

  // The work starts the moment you let go; the animation is only how it looks.
  function handOff(hit, v) {
    const person = hit.person;
    api(`/api/crew/${person.id}/job`, { method: 'POST', body: { jobName: job.name } });
    select(person.id);

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
  renderChat();
}
window.__render = renderAll; // handy for the Playwright checks

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
