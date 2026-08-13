// Shared helpers for Phase 0 spikes.
// Windows: `spawn(bin, args)` does not work for the `claude` launcher — the argv
// must be joined into one string and run through the shell. Killing then needs
// `taskkill /T /F` because the shell hop leaves grandchildren alive.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

/** Quote an argv element for cmd.exe. */
function q(a) {
  const s = String(a);
  if (s === '') return '""';
  return /[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Never let a session fall back to a billed API path — subscription login only.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export function spawnClaude(args, opts = {}) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const base = { env: childEnv(opts.env), cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  return isWin
    ? spawn([bin, ...args.map(q)].join(' '), { ...base, shell: true })
    : spawn(bin, args, base);
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

/** Feed stdout chunks, emit one parsed JSON object per line. */
export function lineJson(onEvent, onRaw) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      onRaw?.(line);
      try { onEvent(JSON.parse(line)); }
      catch { onRaw?.(`[unparsed] ${line}`); }
    }
  };
}

/** Text of an assistant event, if any. */
export function assistantText(ev) {
  const blocks = ev?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
}

export function pass(msg) { console.log(`\nPASS — ${msg}`); process.exitCode = 0; }
export function fail(msg) { console.log(`\nFAIL — ${msg}`); process.exitCode = 1; }
