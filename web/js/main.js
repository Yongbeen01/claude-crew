import { Office } from './office.js';
import { avatarOf, character } from './sprites.js';

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
};

const office = new Office(el.office, el.plates);
window.__office = office;

office.onSeatClick = () => openHire();
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
    });
    el.version.textContent = `v${s.meta?.version ?? ''}`;
    renderAll();
  });

  es.addEventListener('crew', (e) => { store.crew = JSON.parse(e.data); renderCrew(); });
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
    if (m.role === 'assistant') store.streaming.delete(m.personId);
    const list = store.chats.get(m.personId) ?? [];
    list.push({ role: m.role, text: m.text, at: m.at });
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
  el.chat.innerHTML = '';
  for (const m of msgs) el.chat.appendChild(bubbleEl(m.role, m.text));
  if (streaming) el.chat.appendChild(bubbleEl('assistant', streaming, true));
  if (!msgs.length && !streaming) {
    el.chat.innerHTML = '<p class="muted empty">아직 대화가 없습니다.</p>';
  }
  if (atBottom) el.chat.scrollTop = el.chat.scrollHeight;
}

function bubbleEl(role, text, streaming = false) {
  const d = document.createElement('div');
  d.className = `msg ${role}${streaming ? ' streaming' : ''}`;
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
  store.selectedId = null;
  office.selectedId = null;
  renderChat();
});

// ── hire sheet ───────────────────────────────────────────────────────────
function openHire() {
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
  el.hire.hidden = false;
}

async function hire(personaKey) {
  el.hire.hidden = true;
  const r = await api('/api/crew', {
    method: 'POST',
    body: { personaKey, watch: el.hireWatch.checked },
  });
  if (r.ok && r.person) select(r.person.id);
  else if (r.error) alert(r.error);
}

el.hireCancel.addEventListener('click', () => { el.hire.hidden = true; });
el.hire.addEventListener('click', (e) => { if (e.target === el.hire) el.hire.hidden = true; });

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

el.openTypes.addEventListener('click', () => openTypes());
el.typesClose.addEventListener('click', () => { el.types.hidden = true; });
el.types.addEventListener('click', (e) => { if (e.target === el.types) el.types.hidden = true; });

async function openTypes() {
  el.types.hidden = false;
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
    card.draggable = true;
    card.innerHTML = '<b></b><small></small>';
    card.querySelector('b').textContent = j.name;
    card.querySelector('small').textContent =
      `${j.runCount}회${j.avgMinutes ? ` · 보통 ${j.avgMinutes}분` : ''}`;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', j.name);
      e.dataTransfer.effectAllowed = 'copy';
      el.stage.classList.add('drop-target');
    });
    card.addEventListener('dragend', () => el.stage.classList.remove('drop-target'));
    el.jobs.appendChild(card);
  }
}

// Dropping a card on someone hands them the job plus everything the office has
// learned about it — that is the whole point of the card.
el.stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
el.stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.stage.classList.remove('drop-target');
  const jobName = e.dataTransfer.getData('text/plain');
  if (!jobName) return;
  const hit = office.hitAtClient(e.clientX, e.clientY);
  if (!hit?.person) return;
  await api(`/api/crew/${hit.person.id}/job`, { method: 'POST', body: { jobName } });
  select(hit.person.id);
});

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

function renderAll() {
  renderCrew();
  renderUsage();
  renderSystem();
  renderActivity();
  renderApprovals();
  renderTasks();
  renderJobs();
  renderChat();
}

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
