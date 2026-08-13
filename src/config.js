import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checked-out app. Replaced wholesale on update — never store data here. */
export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

export const HOME = os.homedir();

/**
 * Everything the user owns lives outside the repo so `git pull` on update can
 * never wipe a work history, a job instruction, or an edited persona.
 */
export const DATA_DIR = process.env.CLAUDE_CREW_DIR
  ? path.resolve(process.env.CLAUDE_CREW_DIR)
  : path.join(HOME, '.claude-crew');

export const PERSONAS_DIR = path.join(DATA_DIR, 'personas');
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const SEED_PERSONAS_DIR = path.join(ROOT, 'personas');

/** Claude Code's own home — we only ever read it, plus install hooks into settings.json. */
export const CLAUDE_HOME = path.join(HOME, '.claude');
export const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_HOME, 'settings.json');

const DEFAULTS = {
  port: 4320, // claude-office sits on 4319; hooks identify themselves by port so both can run
  host: '127.0.0.1',

  /** how many people can sit in the office at once — one Claude session each */
  maxSeats: 4,

  /** default model per spawned person unless the persona overrides it */
  defaultModel: 'sonnet',

  /** `claude` binary. Only ever run as a child process; never handed credentials. */
  claudeBin: process.env.CLAUDE_BIN || 'claude',

  /** a person with no output for this long is drawn asleep at the desk */
  idleAfterMs: 5 * 60 * 1000,

  /**
   * How long a PermissionRequest hook is held open waiting for a click.
   * 0 = hold until clicked. Closing every browser tab releases them anyway.
   */
  approvalHoldMs: 0,
  approvalFallbackDecision: 'ask',
  holdOnlyWhenViewerConnected: true,

  openBrowserOnStart: true,

  /** one-line "what is this doing" summaries under each nameplate */
  summaries: true,
  summaryModel: 'haiku',
  summaryMinIntervalMs: 90_000,
  summaryTimeoutMs: 45_000,
  summaryConcurrency: 2,

  /** remaining-limit panel, read via `claude -p /usage` (no credential file access) */
  usage: true,
  usagePollMs: 5 * 60 * 1000,
  usageTimeoutMs: 60_000,

  systemPollMs: 4000,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const userConfig = readJson(path.join(DATA_DIR, 'config.json')) ?? {};
export const config = { ...DEFAULTS, ...userConfig };

if (process.env.CLAUDE_CREW_PORT) config.port = Number(process.env.CLAUDE_CREW_PORT);
if (process.env.CLAUDE_CREW_NO_OPEN) config.openBrowserOnStart = false;

export const baseUrl = `http://${config.host}:${config.port}`;

export function ensureDirs() {
  for (const dir of [DATA_DIR, PERSONAS_DIR, JOBS_DIR, SESSIONS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return DATA_DIR;
}
