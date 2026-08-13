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
  activity: document.getElementById('activity'),
  usage: document.getElementById('usage'),
  system: document.getElementById('system'),
  version: document.getElementById('version'),
  hint: document.getElementById('hint'),
  hire: document.getElementById('hire'),
  hireWatch: document.getElementById('hire-watch'),
  personaList: document.getElementById('persona-list'),
  hireCancel: document.getElementById('hire-cancel'),
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
      crew: s.crew, personas: s.personas, activity: s.activity,
      system: s.system, usage: s.usage, meta: s.meta,
    });
    el.version.textContent = `v${s.meta?.version ?? ''}`;
    renderAll();
  });

  es.addEventListener('crew', (e) => { store.crew = JSON.parse(e.data); renderCrew(); });
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
  if (!text || !person) return;
  el.prompt.value = '';
  el.send.disabled = true;
  await api(`/api/crew/${person.id}/send`, { method: 'POST', body: { text } });
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
