import { execFile } from 'node:child_process';
import { DATA_DIR, config } from './config.js';
import { claudeArgv } from './tools.js';
import { bus } from './bus.js';
import { childEnv } from './runner.js';

/**
 * How much of the user's Claude limits is left — the same numbers `/usage` shows
 * inside Claude Code. Read through the CLI in print mode, so this never touches
 * `~/.claude/.credentials.json`; the CLI uses the login it already has.
 *
 * Output lines look like:
 *   Current session: 31% used · resets Aug 12, 7:50pm (Asia/Seoul)
 *   Current week (all models): 46% used · resets Aug 16, 5am (Asia/Seoul)
 */

let latest = { limits: [], scannedAt: 0, error: '', stale: false };
let running = false;

const LINE = /^\s*(.+?):\s*(\d+(?:\.\d+)?)%\s*used\s*(?:·\s*resets\s*(.+?))?\s*$/i;

export function parseUsage(text) {
  const limits = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || !/%\s*used/i.test(line)) continue;
    const m = line.match(LINE);
    if (!m) continue;
    const used = Number(m[2]);
    if (!Number.isFinite(used)) continue;
    limits.push({
      label: cleanLabel(m[1]),
      usedPercent: Math.max(0, Math.min(100, used)),
      leftPercent: Math.max(0, Math.min(100, 100 - used)),
      resets: (m[3] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
    });
  }
  return limits;
}

function cleanLabel(label) {
  return label
    .replace(/^Current\s+/i, '')
    .replace(/^session$/i, '세션')
    .replace(/^week\s*\(all models\)$/i, '주간 · 전체')
    .replace(/^week\s*\((.+)\)$/i, '주간 · $1')
    .replace(/^week$/i, '주간')
    .trim();
}

export function usageReport() {
  return latest;
}

export function refreshUsage() {
  if (running || !config.usage) return latest;
  running = true;
  try {
    return spawnUsage();
  } catch (err) {
    // 여기서 던지면 부팅 중이던 앱이 통째로 죽는다. 한도 표시는 편의지
    // 앱이 서 있어야 할 이유가 아니다.
    running = false;
    latest = { ...latest, stale: true, error: String(err?.message ?? err).slice(0, 120) };
    bus.emit('usage', latest);
    return latest;
  }
}

function spawnUsage() {
  // claude 가 .cmd 껍데기인 컴퓨터도 있다 — claudeArgv 가 그걸 가려 준다.
  const c = claudeArgv([
    '-p', '/usage',
    '--model', config.summaryModel,
    '--no-session-persistence',
    '--strict-mcp-config',
    '--settings', '{"disableAllHooks":true}',
  ]);
  execFile(
    c.cmd,
    c.args,
    { cwd: DATA_DIR, env: childEnv(), timeout: config.usageTimeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
    (err, stdout) => {
      running = false;
      const limits = err ? [] : parseUsage(stdout);
      if (limits.length) {
        latest = { limits, scannedAt: Date.now(), error: '', stale: false };
      } else {
        // Keep the last good numbers rather than blanking the panel.
        latest = {
          ...latest,
          stale: true,
          error: err ? String(err.message).slice(0, 120) : '한도 정보를 읽지 못했습니다',
        };
      }
      bus.emit('usage', latest);
    },
  );
  return latest;
}

export function startUsagePolling() {
  refreshUsage();
  const t = setInterval(refreshUsage, config.usagePollMs);
  t.unref?.();
  return () => clearInterval(t);
}
