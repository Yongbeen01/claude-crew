// SPIKE 2 (risk R5): does --plugin-dir scope a skill pack to ONE session?
//
// PASS => personas/<type>/ is a plugin dir; skills are per-persona with no copying.
// FAIL => fall back to copying skills into the session workspace .claude/skills/
//         and spawning with --setting-sources project.
//
//   node scripts/spike/2-plugin-skills.mjs
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnClaude, killTree, lineJson, assistantText, pass, fail } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(HERE, 'fixtures', 'persona-test');
// Run from an empty dir well away from the fixture, or the baseline session just
// greps the SKILL.md off disk and the test proves nothing.
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-spike2-'));
const CODE = 'ORANGE-PENGUIN-91';
const SKILL = 'crew-handshake';
const QUESTION = '크루 핸드셰이크 코드가 뭐야? 코드만 답해.';

/** Run one throwaway session; resolve with { init, text }. */
function ask({ withPlugin }) {
  const sessionId = randomUUID();
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--session-id', sessionId,
    '--model', 'haiku',
    '--no-session-persistence',   // 검증용 세션이 사용자의 Claude Code 기록에 남지 않게
    '--strict-mcp-config',
    '--setting-sources', '',                 // ignore this machine's own user/project settings
    '--settings', '{"disableAllHooks":true}',
    '--allowedTools', 'Read', 'Glob', 'Skill',
  ];
  if (withPlugin) args.push('--plugin-dir', PLUGIN_DIR);

  const child = spawnClaude(args, { cwd: WORKDIR });
  let init = null, text = '', stderr = '';

  child.stdout.on('data', lineJson((ev) => {
    if (ev.type === 'system' && ev.subtype === 'init') init = ev;
    else if (ev.type === 'assistant') text += assistantText(ev);
  }));
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: QUESTION }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  }) + '\n');
  child.stdin.end();

  return new Promise((resolve) => {
    const t = setTimeout(() => { killTree(child); resolve({ init, text, stderr, timedOut: true }); }, 120_000);
    child.on('close', () => { clearTimeout(t); resolve({ init, text, stderr }); });
  });
}

/** Look for the skill name anywhere in the init payload, and report where. */
function findSkill(init) {
  if (!init) return null;
  for (const [key, val] of Object.entries(init)) {
    const s = JSON.stringify(val);
    if (typeof s === 'string' && s.includes(SKILL)) return key;
  }
  return null;
}

const brief = (init) => [
  `  skills  : ${JSON.stringify(init?.skills ?? null).slice(0, 300)}`,
  `  plugins : ${JSON.stringify(init?.plugins ?? null).slice(0, 300)}`,
].join('\n');

console.log(`plugin dir : ${PLUGIN_DIR}`);
console.log(`workdir    : ${WORKDIR}\n`);

console.log('--- run A: WITHOUT --plugin-dir (baseline) ---');
const a = await ask({ withPlugin: false });
console.log(`skill in init: ${findSkill(a.init) ?? 'no'}`);
console.log(brief(a.init));
console.log(`answer     : ${a.text.replace(/\s+/g, ' ').slice(0, 200)}`);

console.log('\n--- run B: WITH --plugin-dir ---');
const b = await ask({ withPlugin: true });
const where = findSkill(b.init);
console.log(`skill in init: ${where ?? 'no'}`);
console.log(brief(b.init));
console.log(`answer     : ${b.text.replace(/\s+/g, ' ').slice(0, 200)}`);
if (b.stderr) console.log(`stderr     : ${b.stderr.slice(0, 400)}`);

const aKnows = a.text.includes(CODE);
const bKnows = b.text.includes(CODE);

console.log(`\nA knows code: ${aKnows}   B knows code: ${bKnows}   B init lists skill: ${!!where}`);

if (aKnows) fail('baseline session already knew the code — fixture leaked, test is invalid');
else if (bKnows) pass(`--plugin-dir loaded the skill into that session only${where ? ` (init.${where})` : ''}`);
else if (where) fail(`skill appears in init.${where} but was not used — check SKILL.md description wording`);
else fail('--plugin-dir did not expose the skill — use the copy-into-workspace fallback');
