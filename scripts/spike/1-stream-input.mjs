// SPIKE 1 (risk R1): can one long-lived `claude` child process take MULTIPLE
// user turns over stdin via --input-format stream-json, keeping context?
//
// PASS => runner.js keeps one process per person and writes turns to stdin.
// FAIL => fall back to one process per turn with --resume <sessionId>.
//
//   node scripts/spike/1-stream-input.mjs
import { randomUUID } from 'node:crypto';
import { spawnClaude, killTree, lineJson, assistantText, pass, fail } from './lib.mjs';

const SECRET = '8347';
const sessionId = randomUUID();
const VERBOSE = process.env.SPIKE_VERBOSE === '1';

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--session-id', sessionId,
  '--model', 'haiku',
  '--tools', '',                 // conversation only — keeps the spike fast and cheap
  '--strict-mcp-config',
  '--settings', '{"disableAllHooks":true}',
];

console.log(`session-id  : ${sessionId}`);
console.log(`args        : ${args.join(' ')}\n`);

const child = spawnClaude(args, { cwd: process.cwd() });
const turns = [];               // collected result events
let sawInit = null;
let stderr = '';

child.stdout.on('data', lineJson(
  (ev) => {
    if (ev.type === 'system' && ev.subtype === 'init') {
      sawInit = ev;
      console.log(`[init] session_id=${ev.session_id} model=${ev.model ?? '?'}`);
    } else if (ev.type === 'assistant') {
      const t = assistantText(ev);
      if (t) console.log(`[assistant] ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
    } else if (ev.type === 'result') {
      console.log(`[result] subtype=${ev.subtype} is_error=${ev.is_error} session_id=${ev.session_id}`);
      turns.push(ev);
    } else if (VERBOSE) {
      console.log(`[${ev.type}]`, JSON.stringify(ev).slice(0, 160));
    }
  },
  (raw) => { if (VERBOSE) console.log(`  raw> ${raw.slice(0, 200)}`); },
));

child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

function send(text) {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
  console.log(`\n--> ${text}`);
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const waitFor = (n, ms) => new Promise((resolve, reject) => {
  const t = setInterval(() => { if (turns.length >= n) { clearInterval(t); resolve(); } }, 150);
  setTimeout(() => { clearInterval(t); reject(new Error(`timeout waiting for result #${n}`)); }, ms);
});

const exited = new Promise((r) => child.on('close', (code) => r(code)));

try {
  send(`숫자 ${SECRET} 을 기억해. "알겠다" 라고만 답해.`);
  await waitFor(1, 90_000);

  // The decisive check: a SECOND turn on the SAME still-running process.
  send('내가 기억하라고 한 숫자가 뭐였지? 숫자만 답해.');
  await waitFor(2, 90_000);

  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))]);
  console.log(`\nexit code   : ${code}`);

  const answer = String(turns[1]?.result ?? '');
  console.log(`turn2 result: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`);

  if (!sawInit) fail('no system/init event — could not confirm session start');
  else if (turns.some((t) => t.is_error)) fail(`a turn returned is_error. stderr: ${stderr.slice(0, 400)}`);
  else if (!answer.includes(SECRET)) fail(`turn 2 did not recall ${SECRET} — context not shared across turns`);
  else if (turns[1]?.session_id !== sessionId) fail(`session_id drifted: ${turns[1]?.session_id}`);
  else pass('one process, two turns, shared context, stable session-id');
} catch (err) {
  console.log(`\nerror       : ${err.message}`);
  if (stderr) console.log(`stderr      : ${stderr.slice(0, 800)}`);
  fail('streaming stdin multi-turn did not work — use the --resume fallback');
} finally {
  killTree(child);
}
