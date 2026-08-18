import fs from 'node:fs';
import path from 'node:path';
import { PERSONAS_DIR, SEED_PERSONAS_DIR, ensureDirs, config } from './config.js';

/**
 * A person type is just a folder. It doubles as a Claude Code plugin directory,
 * so `--plugin-dir <folder>` loads exactly that type's skills into exactly that
 * session (verified in scripts/spike/2-plugin-skills.mjs) — no copying, and an
 * edit here shows up the next time someone of that type is spawned.
 *
 *   personas/<key>/
 *     persona.json            label, model, tools, sprite, kickoff …
 *     system.md               appended to the session's system prompt
 *     .claude-plugin/plugin.json
 *     skills/<name>/SKILL.md
 */

const REQUIRED = ['label'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Put the shipped types in the user's data dir on first run. Never overwrites:
 * once a type exists it belongs to the user, and an app update must not undo
 * their edits.
 */
export function seedPersonas() {
  ensureDirs();
  if (!fs.existsSync(SEED_PERSONAS_DIR)) return [];
  const added = [];
  for (const entry of fs.readdirSync(SEED_PERSONAS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(PERSONAS_DIR, entry.name);
    if (fs.existsSync(target)) continue;
    copyDir(path.join(SEED_PERSONAS_DIR, entry.name), target);
    added.push(entry.name);
  }
  return added;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Skills this type will hand to a session, read straight off disk. */
export function listSkills(key) {
  const dir = path.join(PERSONAS_DIR, key, 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = path.join(dir, e.name, 'SKILL.md');
      const body = readText(file);
      const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fm = m?.[1] ?? '';
      const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      return { name: e.name, description: desc, file, body };
    });
}

export function loadPersona(key) {
  const dir = path.join(PERSONAS_DIR, key);
  const meta = readJson(path.join(dir, 'persona.json'));
  if (!meta) return null;
  for (const field of REQUIRED) if (!meta[field]) return null;
  return {
    key,
    dir,
    label: meta.label,
    blurb: meta.blurb ?? '',
    sprite: meta.sprite ?? key,
    model: meta.model ?? config.defaultModel,
    effort: meta.effort ?? null,
    permissionMode: meta.permissionMode ?? 'default',
    /** this type cannot do its job without the visible browser (영화감독) */
    watch: meta.watch === true,
    /** toolbox groups this type needs — fetched the first time one is hired */
    toolbox: Array.isArray(meta.toolbox) ? meta.toolbox : [],
    tools: meta.tools ?? null,
    allowedTools: meta.allowedTools ?? null,
    disallowedTools: meta.disallowedTools ?? null,
    strictMcp: meta.strictMcp !== false,
    settingSources: meta.settingSources ?? 'user',
    /** hidden first message so the person opens the conversation, not the user */
    kickoff: meta.kickoff ?? '',
    systemPrompt: readText(path.join(dir, 'system.md')).trim(),
    skills: listSkills(key),
  };
}

export function listPersonas() {
  ensureDirs();
  let entries = [];
  try { entries = fs.readdirSync(PERSONAS_DIR, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => loadPersona(e.name))
    .filter(Boolean)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Write one skill body back to disk. Next spawn of this type picks it up. */
export function saveSkill(key, skillName, body) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(skillName))) throw new Error('bad skill name');
  const dir = path.join(PERSONAS_DIR, key, 'skills', skillName);
  if (!fs.existsSync(path.join(PERSONAS_DIR, key))) throw new Error('unknown persona');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), String(body), 'utf8');
  return listSkills(key).find((s) => s.name === skillName) ?? null;
}

/**
 * Add what a leaving person worked out to one of this type's skills.
 *
 * Appends under a single "배운 것" heading and never repeats a line, so the file
 * grows by what is genuinely new rather than by every session that re-learned
 * the same lesson. Creates the skill — with frontmatter, or the CLI will not
 * load it — the first time this type has anything to remember.
 *
 * @returns {number} how many lines were actually new
 */
export function appendSkillLines(key, skillName, newLines) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(skillName))) return 0;
  if (!fs.existsSync(path.join(PERSONAS_DIR, key))) return 0;
  const dir = path.join(PERSONAS_DIR, key, 'skills', skillName);
  const file = path.join(dir, 'SKILL.md');

  let body = readText(file);
  if (!body.trim()) {
    body = [
      '---',
      `name: ${skillName}`,
      'description: 이 자리에서 일해 본 사람들이 남긴 것. 비슷한 일을 맡으면 먼저 읽는다.',
      '---',
      '',
    ].join('\n');
  }

  const HEADING = '## 배운 것';
  if (!body.includes(HEADING)) body = `${body.replace(/\n+$/, '')}\n\n${HEADING}\n`;

  const known = new Set(
    body.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean),
  );
  const added = newLines.filter((l) => !known.has(l));
  if (!added.length) return 0;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${body.replace(/\n+$/, '')}\n${added.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
  return added.length;
}

export function deleteSkill(key, skillName) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(skillName))) throw new Error('bad skill name');
  const dir = path.join(PERSONAS_DIR, key, 'skills', skillName);
  if (!dir.startsWith(path.join(PERSONAS_DIR, key))) throw new Error('escape');
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Persist edits to persona.json (label, model, kickoff, …). */
export function savePersonaMeta(key, patch) {
  const file = path.join(PERSONAS_DIR, key, 'persona.json');
  const current = readJson(file);
  if (!current) throw new Error('unknown persona');
  // A model or effort the CLI does not know would not fail loudly — it warns on
  // stderr and runs on the default — so a bad default has to be refused here,
  // where someone is still around to be told.
  if ('model' in patch && !config.models.includes(String(patch.model))) {
    throw new Error(`모르는 모델입니다: ${patch.model}`);
  }
  if ('effort' in patch && !config.efforts.includes(String(patch.effort))) {
    throw new Error(`모르는 생각 깊이입니다: ${patch.effort}`);
  }
  const allowed = ['label', 'blurb', 'model', 'effort', 'permissionMode', 'kickoff', 'strictMcp', 'sprite'];
  const next = { ...current };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return loadPersona(key);
}

export function saveSystemPrompt(key, body) {
  const file = path.join(PERSONAS_DIR, key, 'system.md');
  if (!fs.existsSync(path.join(PERSONAS_DIR, key))) throw new Error('unknown persona');
  fs.writeFileSync(file, String(body), 'utf8');
  return loadPersona(key);
}
