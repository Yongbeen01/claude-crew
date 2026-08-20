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
  maxSeats: 6,

  /** default model per spawned person unless the persona overrides it */
  defaultModel: 'sonnet',

  /**
   * What the 모델 / 생각 깊이 pickers offer.
   *
   * The effort levels are the CLI's own — it names them itself when handed a
   * bad one ("Valid values: low, medium, high, xhigh, max"). Keep this list in
   * step with that, because an unknown value is not refused: it is warned about
   * on stderr and silently replaced by the default, which would leave the office
   * showing a setting the session is not actually running under.
   */
  models: ['opus', 'sonnet', 'haiku'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],

  /**
   * 영상 속 말을 받아 적는 모델. 이 컴퓨터 안에서 돈다 — 앱이 API 키를 쓰지
   * 않는다는 규칙은 받아쓰기에도 그대로다.
   *
   * small  240MB · 한국어가 사실상 정확하고 30초 소리에 20초쯤 (기본)
   * base    76MB · 가볍지만 한국어에서 낱말을 흘린다 ("세 단계" → "새 단계")
   * large-v3-turbo  1.1GB · 가장 정확하고 두 배 느리다
   */
  sttModel: 'onnx-community/whisper-small',

  /** `claude` binary. Only ever run as a child process; never handed credentials. */
  claudeBin: process.env.CLAUDE_BIN || 'claude',

  /** a person with no output for this long is drawn asleep at the desk */
  idleAfterMs: 5 * 60 * 1000,

  /**
   * How long a tool call is held waiting for a click. 0 = until decided.
   * Unlike claude-office — which was holding up the user's own IDE — holding
   * here only parks a background worker, so waiting is the sane default.
   */
  approvalHoldMs: 0,
  approvalFallbackDecision: 'ask',
  holdOnlyWhenViewerConnected: false,

  /**
   * Tools that never need a click. Reading and searching are reversible and
   * asking about each one would make the office unusable; anything that writes,
   * runs, or sends is left to the user.
   */
  autoAllowTools: [
    'Read', 'Glob', 'Grep', 'NotebookRead',
    'Skill', 'ToolSearch', 'TodoWrite',
    'WebSearch', 'WebFetch',
  ],

  openBrowserOnStart: true,

  /** one-line "what is this doing" summaries under each nameplate */
  summaries: true,
  summaryModel: 'haiku',
  summaryMinIntervalMs: 90_000,
  summaryTimeoutMs: 45_000,
  summaryConcurrency: 2,

  /**
   * Leaving. A person on the way out is asked what the next one should know,
   * and the answer is filed into the job's instructions and this type's skills.
   * The walk to the door is the wait — hence a floor, so the animation is never
   * cut short by a fast answer.
   */
  handover: true,
  handoverModel: 'sonnet',
  handoverTimeoutMs: 120_000,
  /** the crying / packing / trudging choreography, start to door */
  leaveAnimMs: 9200,

  /**
   * The windows zone: everything you have open, drawn as people. Windows only —
   * there is no equivalent enumeration on the other platforms, and the office
   * simply shows one zone there.
   */
  desktop: true,
  desktopPollMs: 3500,

  /** remaining-limit panel, read via `claude -p /usage` (no credential file access) */
  usage: true,
  usagePollMs: 5 * 60 * 1000,
  usageTimeoutMs: 60_000,

  systemPollMs: 4000,

  /**
   * 새 버전 받기.
   *
   * 이건 밀어 주는 방식이 아니라 각자 물어보는 방식이라, 주기가 곧 "새 것을
   * 낸 뒤 남들이 언제 그걸 쓰게 되는가" 다. 6시간이던 때는 켜 둔 사람이 반나절
   * 뒤에야 알았고, 알아도 띠를 눌러야 해서 안 누르면 그 컴퓨터만 영영 옛
   * 버전으로 굳었다 — 실제로 그렇게 됐다.
   *
   * autoUpdate 는 묻지 않고 받아서 다시 켠다. 예전에는 그러면 앉아 있던
   * 사람들이 통째로 끝나 버려서 못 할 짓이었는데, 이제 대화 그대로 돌아오므로
   * (crew.revive) 알아채지 못하는 사이에 지나가도 되는 일이 됐다. 그래도
   * **일하는 사람이 하나라도 있으면 기다린다** — 돌던 턴은 못 살리기 때문이다.
   */
  checkUpdates: true,
  autoUpdate: true,
  updatePollMs: 30 * 60 * 1000,
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
