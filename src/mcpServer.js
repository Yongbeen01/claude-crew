import { randomUUID } from 'node:crypto';
import { baseUrl } from './config.js';
import { bus, logActivity } from './bus.js';
import * as jobs from './jobs.js';
import * as timers from './timers.js';

/**
 * The office's own MCP server — how a session hands structured data back.
 *
 * Mounted at /mcp/<token>. Each person gets a fresh token at hire time, so a
 * tool call is attributable to exactly one person without the model having to
 * be trusted to say who it is.
 *
 * Verified in scripts/spike/3-app-mcp.mjs: three JSON-RPC methods are enough
 * (`initialize`, `tools/list`, `tools/call`), notifications get a bare 202, and
 * a single `application/json` response works — no SSE transport needed.
 */

/** token -> personId */
const tokens = new Map();
/** Hooks set by crew.js so tools can act on the caller. */
let hooks = { setSummary: () => {}, getPerson: () => null };

export function bindHooks(next) {
  hooks = { ...hooks, ...next };
}

export function issueToken(personId) {
  const token = randomUUID();
  tokens.set(token, personId);
  return token;
}

export function revokeTokensFor(personId) {
  for (const [token, id] of tokens) if (id === personId) tokens.delete(token);
}

/** The same token also identifies a person's hook callbacks. */
export function personIdForToken(token) {
  return tokens.get(token) ?? null;
}

/** A person's existing token, so a restart keeps the same MCP + hook URLs. */
export function tokenFor(personId) {
  for (const [token, id] of tokens) if (id === personId) return token;
  return null;
}

/** What goes into a session's --mcp-config. */
export function mcpConfigFor(token) {
  return { office: { type: 'http', url: `${baseUrl}/mcp/${token}` } };
}

/**
 * These are the app's own tools talking to the app's own store on localhost.
 * There is nothing for a user to approve, so they are pre-allowed on every
 * session — otherwise headless permission checks silently deny them and the
 * person reports that it "can't save anything".
 */
export function officeToolNames() {
  return TOOLS.map((t) => `mcp__office__${t.name}`);
}

const TOOLS = [
  {
    name: 'set_status',
    description:
      'Update the one-line status shown under your nameplate in the office UI. Call it when you start something and when you finish. Korean, 12 characters or fewer.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '예: "수불부 검산 중"' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_task_list',
    description:
      "Save today's task list once the user has confirmed what they're doing and roughly how long each item takes. Replaces the whole list, so send every task each time.",
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              minutes: { type: 'number', description: 'Estimated minutes. Omit only if truly unknown.' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_timer',
    description:
      'Start the clock on one task. The app owns the countdown and will message you at 60, 30 and 15 minutes left and at the end — do not wait or count time yourself. Call this and end your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        taskName: { type: 'string' },
        minutes: { type: 'number' },
      },
      required: ['taskName', 'minutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_timer',
    description: 'Stop the running timer, e.g. when the user says they are done or switching tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'log_work',
    description:
      'Record a finished piece of work. Do this whenever a task completes — it is what teaches the office how long this kind of job really takes and turns it into a reusable card.',
    inputSchema: {
      type: 'object',
      properties: {
        jobName: { type: 'string', description: 'Short stable name, e.g. "8월 수불부 마감". Reuse the same name for the same recurring job.' },
        summary: { type: 'string', description: 'What was actually done, and anything the next run should know.' },
        minutes: { type: 'number', description: 'Actual minutes spent, if known.' },
      },
      required: ['jobName', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_jobs',
    description: 'List the jobs this user does repeatedly, with how often and how long they usually take.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_job',
    description:
      'Read everything known about one recurring job: accumulated instructions, average duration, and the most recent runs. Check this before asking the user how they want something done.',
    inputSchema: {
      type: 'object',
      properties: { jobName: { type: 'string' } },
      required: ['jobName'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    description:
      "Store one durable instruction about how this user likes a job done, so nobody has to ask again next time. One short sentence per call. Use it for confirmed preferences and corrections — not for one-off details.",
    inputSchema: {
      type: 'object',
      properties: {
        jobName: { type: 'string' },
        instruction: { type: 'string', description: '예: "합계는 항상 원본과 대조해서 결과를 같이 알려준다"' },
      },
      required: ['jobName', 'instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify',
    description: 'Send the user a desktop notification. For things they need to see when they are not looking at the office.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function text(body) {
  return { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }] };
}

function call(personId, name, args = {}) {
  const person = hooks.getPerson(personId);
  const who = person?.name ?? '누군가';

  switch (name) {
    case 'set_status': {
      hooks.setSummary(personId, args.text);
      return text('ok');
    }

    case 'save_task_list': {
      const tasks = timers.saveTaskList(args.tasks, { personId });
      return text({ saved: tasks.length, tasks });
    }

    case 'start_timer': {
      const t = timers.startTimer({ taskName: args.taskName, minutes: args.minutes, personId });
      if (!t) return text('taskName 과 minutes 가 필요합니다.');
      return text({
        started: t.taskName,
        minutes: t.minutes,
        note: '앱이 60/30/15분 전과 종료 시점에 알려줍니다. 기다리지 말고 턴을 끝내세요.',
      });
    }

    case 'stop_timer': {
      const stopped = timers.stopTimer({ personId });
      return text(stopped ? { stopped: stopped.taskName, actualMinutes: stopped.actualMinutes } : '실행 중인 타이머가 없습니다.');
    }

    case 'log_work': {
      const job = jobs.logWork({
        jobName: args.jobName,
        summary: args.summary,
        minutes: args.minutes,
        personaKey: person?.personaKey,
        personId,
      });
      if (!job) return text('jobName 이 필요합니다.');
      return text({ job: job.name, runCount: job.runCount, avgMinutes: job.avgMinutes });
    }

    case 'list_jobs':
      return text(jobs.listJobs().map((j) => ({
        name: j.name, runCount: j.runCount, avgMinutes: j.avgMinutes, lastRunAt: j.lastRunAt,
      })));

    case 'get_job': {
      const job = jobs.getJob(args.jobName);
      if (!job) return text(`"${args.jobName}" 에 대한 기록이 아직 없습니다.`);
      return text({
        name: job.name,
        runCount: job.runCount,
        avgMinutes: job.avgMinutes,
        instructions: job.instructions,
        recentRuns: job.runs.map((r) => r.body),
      });
    }

    case 'remember': {
      const job = jobs.remember(args.jobName, args.instruction);
      return text(job ? { remembered: args.instruction, job: job.name } : 'jobName 과 instruction 이 필요합니다.');
    }

    case 'notify': {
      logActivity('notify', `${who} — ${String(args.text).slice(0, 80)}`, personId);
      bus.emit('notify', { personId, text: String(args.text ?? ''), at: Date.now() });
      return text('ok');
    }

    default:
      return text(`unknown tool: ${name}`);
  }
}

/**
 * Handle one POST to /mcp/<token>. Returns true if it took the request.
 */
export function handle(req, res, pathname, body) {
  const m = pathname.match(/^\/mcp\/([^/]+)$/);
  if (!m) return false;

  const personId = tokens.get(m[1]);
  const send = (payload, status = 200) => {
    const s = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };

  if (!personId) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"unknown session token"}');
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return true;
  }

  const msg = body ?? {};
  // Notifications carry no id and must not get a JSON-RPC response.
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return true;
  }

  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-crew-office', version: '1' },
      });
      break;

    case 'tools/list':
      reply({ tools: TOOLS });
      break;

    case 'tools/call':
      try {
        reply(call(personId, msg.params?.name, msg.params?.arguments ?? {}));
      } catch (err) {
        reply({ content: [{ type: 'text', text: `실패: ${err.message}` }], isError: true });
      }
      break;

    default:
      reply({});
  }
  return true;
}
