import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { bus, recentActivity } from './bus.js';
import * as crew from './crew.js';
import { listPersonas, saveSkill, deleteSkill, savePersonaMeta, saveSystemPrompt } from './personas.js';
import { usageReport } from './usage.js';
import * as jobs from './jobs.js';
import * as timers from './timers.js';
import { handle as handleMcp, personIdForToken } from './mcpServer.js';
import * as approvals from './approvals.js';
import * as savedGroups from './savedGroups.js';
import { updateStatus, checkForUpdate, applyUpdate } from './update.js';
import { toolboxStatus } from './toolbox.js';
import { desktopState, focusPerson, refreshDesktop } from './desktop.js';
import * as groups from './groups.js';

const WEB_DIR = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** @type {Set<import('node:http').ServerResponse>} */
const viewers = new Set();

function sse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client vanished */
  }
}

function broadcast(event, data) {
  for (const res of viewers) sse(res, event, data);
}

bus.on('crew', (list) => broadcast('crew', list));
bus.on('delta', (d) => broadcast('delta', d));
bus.on('message', (m) => broadcast('message', m));
bus.on('activity', (e) => broadcast('activity', e));
bus.on('usage', (u) => broadcast('usage', u));
bus.on('personas', (p) => broadcast('personas', p));
bus.on('jobs', (j) => broadcast('jobs', j));
bus.on('tasks', (t) => broadcast('tasks', t));
bus.on('timer', (t) => broadcast('timer', t));
bus.on('notify', (n) => broadcast('notify', n));
bus.on('approvals', (a) => broadcast('approvals', a));
bus.on('approval-resolved', (a) => broadcast('approval-resolved', a));
bus.on('update', (u) => broadcast('update', u));
bus.on('toolbox', (t) => broadcast('toolbox', t));
// 대화창이 '생각 중 → 도구 → 답변' 을 그릴 수 있게 하는 신호들.
// 이 컴퓨터에 열려 있는 창들, 그리고 그 창들을 묶은 그룹.
bus.on('desktop', (d) => broadcast('desktop', d));
bus.on('groups', (g) => broadcast('groups', g));
bus.on('saved-groups', (g) => broadcast('saved-groups', g));
bus.on('phase', (p) => broadcast('phase', p));
bus.on('tool', (t) => broadcast('tool', t));
bus.on('turn-end', (t) => broadcast('turn-end', t));

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// Attachments ride in as base64 JSON, so the cap has to fit a real spreadsheet.
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

function fullState() {
  return {
    crew: crew.snapshot(),
    personas: listPersonas().map(publicPersona),
    jobs: jobs.listJobs(),
    tasks: timers.publicState(),
    approvals: approvals.listApprovals(),
    approvalHistory: approvals.approvalHistory(),
    update: updateStatus(),
    toolbox: toolboxStatus(),
    desktop: desktopState(),
    groups: groups.listGroups(),
    savedGroups: savedGroups.listSaved(),
    activity: recentActivity(),
    usage: usageReport(),
    meta: {
      now: Date.now(),
      maxSeats: config.maxSeats,
      version: readVersion(),
      // The pickers are built from this rather than from a list in the page, so
      // a config edit reaches the UI without a second place to remember.
      models: config.models,
      efforts: config.efforts,
    },
  };
}

let cachedVersion = null;
function readVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** Persona shape the browser gets — skill bodies only on request. */
function publicPersona(p) {
  return {
    key: p.key,
    label: p.label,
    blurb: p.blurb,
    sprite: p.sprite,
    model: p.model,
    effort: p.effort,
    watch: p.watch,
    strictMcp: p.strictMcp,
    kickoff: p.kickoff,
    systemPrompt: p.systemPrompt,
    skills: p.skills.map((s) => ({ name: s.name, description: s.description })),
  };
}

function announcePersonas() {
  bus.emit('personas', listPersonas().map(publicPersona));
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
      return res.end();
    }

    // ---- hook receiver ------------------------------------------------------
    // /hook/<person token>/<Event>. The PreToolUse response is held open until
    // someone clicks; the decision IS the response body.
    if (p.startsWith('/hook/')) {
      const [, , token, event] = p.split('/');
      const personId = personIdForToken(token);
      const payload = await readBody(req).catch(() => ({}));
      if (event !== 'PreToolUse' || !personId) return json(res, 200, {});

      const result = approvals.requestApproval(personId, payload);
      if (!result.held) return json(res, 200, approvals.decisionBody(result.decision));
      const decision = await result.promise;
      return json(res, 200, approvals.decisionBody(decision));
    }

    // ---- the office's own MCP server ---------------------------------------
    // Sessions reach this at /mcp/<their token>; the token is how we know who
    // called. See scripts/spike/3-app-mcp.mjs.
    if (p.startsWith('/mcp/')) {
      const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : null;
      if (handleMcp(req, res, p, body)) return undefined;
    }

    // ---- live state --------------------------------------------------------
    if (p === '/api/state') return json(res, 200, fullState());

    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      viewers.add(res);
      approvals.setViewerCount(viewers.size);
      sse(res, 'state', fullState());
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        viewers.delete(res);
        // Closing the last tab must never leave a person frozen on a card that
        // is no longer on any screen.
        approvals.setViewerCount(viewers.size);
      });
      return undefined;
    }

    // ---- approvals ---------------------------------------------------------
    if (p.startsWith('/api/approvals/') && req.method === 'POST') {
      const id = p.split('/')[3];
      const body = await readBody(req);
      const decision = ['allow', 'deny', 'ask'].includes(body.decision) ? body.decision : 'ask';
      return json(res, 200, { ok: approvals.resolve(id, decision, 'user') });
    }

    // ---- crew --------------------------------------------------------------
    if (p === '/api/crew' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const person = crew.hire(String(body.personaKey ?? ''), {
          watch: body.watch === true,
          // Unknown or absent falls back to the type's own default.
          model: body.model,
          effort: body.effort,
        });
        return json(res, 200, { ok: true, person: person.toJSON() });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (p.startsWith('/api/crew/')) {
      const [, , , id, sub] = p.split('/');
      const person = crew.get(id);
      if (!person) return json(res, 404, { error: 'unknown person' });

      if (!sub && req.method === 'DELETE') {
        return json(res, 200, { ok: crew.fire(id) });
      }

      // Dragged to the door. Answer at once — the office starts the walk out
      // from the `leaving` state, and the handover behind it takes as long as
      // it takes.
      if (sub === 'leave' && req.method === 'POST') {
        crew.leave(id).catch(() => {});
        return json(res, 200, { ok: true });
      }
      if (!sub) return json(res, 200, person.toJSON());

      if (sub === 'send' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        const files = Array.isArray(body.files) ? body.files : [];
        if (!text && !files.length) return json(res, 400, { ok: false, error: '빈 프롬프트' });
        // Attachments are named in the message, so the person can just read them.
        const message = files.length
          ? [text, '', '첨부한 파일:', ...files.map((f) => `- ${f}`)].join('\n').trim()
          : text;
        return json(res, 200, { ok: crew.send(id, message) });
      }

      if (sub === 'files' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, files: crew.attach(id, body.files) });
      }
      if (sub === 'transcript') {
        return json(res, 200, { personId: id, entries: crew.transcript(id) });
      }
      // 이 사람만 모델·생각 깊이 바꾸기. Restarts onto the same conversation, so
      // it takes a moment and is refused mid-turn (see crew.setTuning).
      if (sub === 'tuning' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await crew.setTuning(id, { model: body.model, effort: body.effort });
        return json(res, r.ok ? 200 : 409, r);
      }
      if (sub === 'watch' && req.method === 'POST') {
        const body = await readBody(req);
        // Restarts the session onto the same conversation, so this can take a
        // couple of seconds.
        return json(res, 200, { ok: await crew.setWatch(id, body.on === true) });
      }
      // Dropping a job card on someone: they get the accumulated briefing.
      if (sub === 'job' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: crew.assignJob(id, String(body.jobName ?? '').trim()) });
      }
      // "이 사람은 그냥 알아서 하게 두기" — stop asking for every tool.
      if (sub === 'trust' && req.method === 'POST') {
        const body = await readBody(req);
        const swallowed = approvals.setTrusted(id, body.on === true);
        crew.touch(id);
        return json(res, 200, { ok: true, on: approvals.isTrusted(id), resolved: swallowed });
      }
    }

    // ---- this computer's own windows ---------------------------------------
    if (p === '/api/desktop') {
      if (req.method === 'POST') await refreshDesktop();
      return json(res, 200, { ...desktopState(), groups: groups.listGroups() });
    }

    // Click a window-person: bring that window (and, for a browser, that exact
    // tab) to the front.
    if (p === '/api/desktop/focus' && req.method === 'POST') {
      const body = await readBody(req);
      const person = desktopState().people.find((x) => x.key === body.key);
      if (!person) return json(res, 404, { ok: false, error: 'unknown window' });
      const r = await focusPerson(person);
      return json(res, 200, { ok: !!r?.ok });
    }

    // Drag a window-person onto a table — or off every table with groupId null.
    if (p === '/api/desktop/assign' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body.key ?? '');
      const groupId = body.groupId ? String(body.groupId) : null;
      return json(res, 200, { ok: groups.assign(key, groupId) });
    }

    if (p === '/api/desktop/groups' && req.method === 'POST') {
      const body = await readBody(req);
      const group = groups.createGroup(body.name);
      // Creating a group by dropping a person on empty floor seats them at once.
      if (body.key) groups.assign(String(body.key), group.id);
      return json(res, 200, { ok: true, group });
    }

    // ---- saved groups ------------------------------------------------------
    if (p === '/api/saved-groups') return json(res, 200, { groups: savedGroups.listSaved() });

    if (p.startsWith('/api/saved-groups/')) {
      const [, , , id, action] = p.split('/');
      if (action === 'open' && req.method === 'POST') {
        try { return json(res, 200, await savedGroups.openSaved(id)); }
        catch (e) { return json(res, 400, { ok: false, error: String(e.message ?? e) }); }
      }
      if (req.method === 'DELETE') return json(res, 200, { ok: savedGroups.deleteSaved(id) });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const g = savedGroups.renameSaved(id, body.name);
        return json(res, g ? 200 : 404, { ok: !!g, group: g });
      }
      return json(res, 200, savedGroups.getSaved(id) ?? { error: 'unknown saved group' });
    }

    if (p.startsWith('/api/desktop/groups/')) {
      const [, , , , id, action] = p.split('/');
      // Freeze this group into something that can be opened again next week.
      if (action === 'save' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        try { return json(res, 200, { ok: true, saved: await savedGroups.saveGroup(id, body.name) }); }
        catch (e) { return json(res, 400, { ok: false, error: String(e.message ?? e) }); }
      }
      if (!action && (req.method === 'POST' || req.method === 'PATCH')) {
        const body = await readBody(req);
        const group = groups.renameGroup(id, body.name);
        return json(res, group ? 200 : 404, { ok: !!group, group });
      }
      if (!action && req.method === 'DELETE') {
        return json(res, 200, { ok: groups.deleteGroup(id) });
      }
      if (req.method === 'POST' && ['open', 'hide', 'toggle'].includes(action)) {
        const fn = { open: groups.openGroup, hide: groups.hideGroup, toggle: groups.toggleGroup }[action];
        return json(res, 200, await fn(id));
      }
    }

    // ---- jobs + today's tasks ----------------------------------------------
    if (p === '/api/jobs') return json(res, 200, { jobs: jobs.listJobs() });

    if (p.startsWith('/api/jobs/')) {
      const [, , , raw, action] = p.split('/');
      const name = decodeURIComponent(raw ?? '');
      const job = jobs.listJobs().find((j) => j.slug === name || j.name === name);
      if (!job) return json(res, 404, { error: 'unknown job' });
      // The accumulated instructions are a draft the user gets to correct —
      // every future session is handed them verbatim.
      if (action === 'instructions' && req.method === 'POST') {
        const body = await readBody(req);
        const saved = jobs.setInstructions(job.name, body.body ?? '');
        return json(res, saved ? 200 : 400, { ok: !!saved, job: saved });
      }
      return json(res, 200, jobs.getJob(job.name));
    }

    if (p === '/api/tasks') return json(res, 200, timers.publicState());

    // ---- self update -------------------------------------------------------
    if (p === '/api/update') {
      if (req.method === 'POST') {
        const result = await applyUpdate();
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.searchParams.get('check') === '1') return json(res, 200, await checkForUpdate());
      return json(res, 200, updateStatus());
    }

    // ---- personas ----------------------------------------------------------
    if (p === '/api/personas') return json(res, 200, { personas: listPersonas().map(publicPersona) });

    if (p.startsWith('/api/personas/')) {
      const parts = p.split('/'); // '', api, personas, <key>, [skills, <name>]
      const key = decodeURIComponent(parts[3] ?? '');
      const persona = listPersonas().find((x) => x.key === key);
      if (!persona) return json(res, 404, { error: 'unknown persona' });

      if (parts.length === 4 && req.method === 'GET') {
        return json(res, 200, { ...publicPersona(persona), skills: persona.skills });
      }
      if (parts.length === 4 && (req.method === 'POST' || req.method === 'PATCH')) {
        const body = await readBody(req);
        try {
          if (typeof body.systemPrompt === 'string') saveSystemPrompt(key, body.systemPrompt);
          const next = savePersonaMeta(key, body);
          announcePersonas();
          return json(res, 200, { ok: true, persona: publicPersona(next) });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
      if (parts[4] === 'skills') {
        const name = decodeURIComponent(parts[5] ?? '');
        try {
          if (req.method === 'POST' || req.method === 'PATCH') {
            const body = await readBody(req);
            const skill = saveSkill(key, name, body.body ?? '');
            announcePersonas();
            return json(res, 200, { ok: true, skill });
          }
          if (req.method === 'DELETE') {
            deleteSkill(key, name);
            announcePersonas();
            return json(res, 200, { ok: true });
          }
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
    }

    if (p === '/healthz') return json(res, 200, { ok: true, viewers: viewers.size, version: readVersion() });

    if (req.method === 'GET') return serveStatic(res, p);
    return json(res, 404, { error: 'not found' });
  });

  // Never cut a held connection: the SSE stream and (later) permission holds
  // both stay open far longer than any default timeout allows.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.setTimeout(0);
  return server;
}

export function viewerCount() {
  return viewers.size;
}
