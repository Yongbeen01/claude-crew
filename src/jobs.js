import fs from 'node:fs';
import path from 'node:path';
import { JOBS_DIR, ensureDirs } from './config.js';
import { paths, readJson, writeJson, appendJsonl, readJsonl } from './store.js';
import { bus, logActivity } from './bus.js';

/**
 * What the user actually does, learned from use.
 *
 * Every finished piece of work is logged against a job name. Once the same job
 * comes back a second time it becomes a card you can drag onto someone, and the
 * instructions collected along the way ride along with it — so the second time
 * you ask for a thing, you don't have to explain it again.
 *
 *   ~/.claude-crew/jobs/<slug>/
 *     job.json         name, runCount, avgMinutes, personaKey, lastRunAt
 *     instructions.md  accumulated "how this person likes it done"
 *     runs/<ts>.md     one file per completed run
 */

/** Job names are Korean; keep the slug readable but filesystem-safe. */
export function slugify(name) {
  const s = String(name ?? '').trim().replace(/[\\/:*?"<>|.\s]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || 'job';
}

function jobDir(slug) {
  return path.join(JOBS_DIR, slug);
}

function readMeta(slug) {
  return readJson(path.join(jobDir(slug), 'job.json'), null);
}

function writeMeta(slug, meta) {
  writeJson(path.join(jobDir(slug), 'job.json'), meta);
}

export function getJob(name) {
  const slug = slugify(name);
  const meta = readMeta(slug);
  if (!meta) return null;
  let instructions = '';
  try {
    instructions = fs.readFileSync(path.join(jobDir(slug), 'instructions.md'), 'utf8');
  } catch { /* none yet */ }
  return { ...meta, slug, instructions, runs: recentRuns(slug, 3) };
}

export function recentRuns(slug, limit = 3) {
  const dir = path.join(jobDir(slug), 'runs');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return files.slice(-limit).map((f) => ({
    at: Number(f.replace('.md', '')) || 0,
    body: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
}

export function listJobs() {
  ensureDirs();
  let entries = [];
  try { entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const meta = readMeta(e.name);
      return meta ? { ...meta, slug: e.name } : null;
    })
    .filter(Boolean)
    // Most-repeated first: the thing you do every week should be easiest to grab.
    .sort((a, b) => b.runCount - a.runCount || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
}

/**
 * 이 일을 목록에서 지운다.
 *
 * 카드 하나가 아니라 그동안 쌓인 지침과 실행 기록이 같이 없어지므로, 화면에서
 * 한 번 물어본 뒤에만 여기까지 온다. 원장(worklog.jsonl)은 건드리지 않는다 —
 * 그건 "무슨 일을 얼마나 했는가" 의 기록이지 이 카드의 소유물이 아니다.
 */
export function deleteJob(name) {
  const slug = slugify(name);
  const dir = jobDir(slug);
  // 슬러그를 거쳤어도 한 번 더 본다. 지우는 명령에서 경로가 밖으로 새면
  // 되돌릴 방법이 없다.
  if (!path.resolve(dir).startsWith(path.resolve(JOBS_DIR) + path.sep)) return false;
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  logActivity('job', `${name} — 자주 하는 일에서 지움`);
  bus.emit('jobs', listJobs());
  return true;
}

/**
 * A person finished something. Adds a run, updates the average, and — from the
 * second run on — the job becomes a draggable card.
 */
export function logWork({ jobName, summary, minutes, personaKey, personId }) {
  const name = String(jobName ?? '').trim();
  if (!name) return null;
  const slug = slugify(name);
  const dir = jobDir(slug);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });

  const at = Date.now();
  const mins = Number.isFinite(Number(minutes)) ? Math.max(0, Math.round(Number(minutes))) : null;

  fs.writeFileSync(
    path.join(dir, 'runs', `${at}.md`),
    `# ${name}\n\n- 시각: ${new Date(at).toISOString()}\n- 소요: ${mins ?? '미기록'}분\n\n${String(summary ?? '').trim()}\n`,
    'utf8',
  );

  const prev = readMeta(slug) ?? { name, runCount: 0, totalMinutes: 0, timedRuns: 0, personaKey: personaKey ?? null };
  const meta = {
    ...prev,
    name,
    personaKey: personaKey ?? prev.personaKey ?? null,
    runCount: prev.runCount + 1,
    totalMinutes: prev.totalMinutes + (mins ?? 0),
    timedRuns: prev.timedRuns + (mins == null ? 0 : 1),
    lastRunAt: at,
  };
  meta.avgMinutes = meta.timedRuns ? Math.round(meta.totalMinutes / meta.timedRuns) : null;
  writeMeta(slug, meta);

  appendJsonl(paths.worklog(), { at, jobName: name, slug, minutes: mins, personId, personaKey, summary });
  logActivity('work', `${name} 완료${mins != null ? ` (${mins}분)` : ''}`, personId ?? null);
  bus.emit('jobs', listJobs());
  return { ...meta, slug };
}

/**
 * Add a line to a job's standing instructions. Deduplicated, because a session
 * that re-learns the same lesson every run would otherwise grow the file forever.
 */
export function remember(jobName, instruction) {
  const name = String(jobName ?? '').trim();
  const line = String(instruction ?? '').trim().replace(/\s+/g, ' ');
  if (!name || !line) return null;
  const slug = slugify(name);
  const dir = jobDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'instructions.md');

  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch { body = `# ${name} — 이렇게 하면 된다\n`; }
  const existing = body.split('\n').map((l) => l.replace(/^-\s*/, '').trim());
  if (existing.includes(line)) return getJob(name);

  fs.writeFileSync(file, `${body.replace(/\n+$/, '')}\n- ${line}\n`, 'utf8');
  if (!readMeta(slug)) {
    writeMeta(slug, { name, runCount: 0, totalMinutes: 0, timedRuns: 0, avgMinutes: null, personaKey: null });
  }
  bus.emit('jobs', listJobs());
  return getJob(name);
}

/**
 * Replace a job's standing instructions wholesale.
 *
 * `remember()` is how a *session* adds a line it worked out; this is how the
 * user rewrites the whole thing. They need to be able to: what accumulates
 * automatically is a rough draft — sometimes wrong, sometimes phrased in a way
 * that will mislead the next person — and it is handed to every future session
 * verbatim, so it has to be correctable by hand.
 */
export function setInstructions(jobName, body) {
  const name = String(jobName ?? '').trim();
  if (!name) return null;
  const slug = slugify(name);
  if (!readMeta(slug)) return null;
  const dir = jobDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'instructions.md'), String(body ?? '').trim() + '\n', 'utf8');
  bus.emit('jobs', listJobs());
  return getJob(name);
}

/**
 * The briefing handed to a person when a job card is dropped on them.
 * Kept plain — it is appended to a system prompt, not shown to the user.
 */
export function briefing(name) {
  const job = getJob(name);
  if (!job) return '';
  const parts = [`## 지금 맡은 일: ${job.name}`];
  if (job.avgMinutes) parts.push(`이 일은 보통 ${job.avgMinutes}분 걸렸습니다 (${job.runCount}회 수행).`);
  if (job.instructions.trim()) {
    parts.push('### 지난번까지 정리된 방식\n' + job.instructions.trim());
  }
  const last = job.runs.at(-1);
  if (last) parts.push(`### 가장 최근 수행\n${last.body.trim().slice(0, 1200)}`);
  parts.push(
    '이 일을 다시 하는 것이므로 이미 아는 것은 묻지 마세요. ' +
    '위 내용으로 판단이 안 서는 것만, 시작 전에 한 번에 모아서 물어보세요. 없으면 바로 시작하세요.',
  );
  return parts.join('\n\n');
}

export function worklog(limit = 200) {
  return readJsonl(paths.worklog(), limit);
}
