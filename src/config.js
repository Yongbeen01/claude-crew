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
   * 승인 카드 하나가 도구 호출을 붙잡아 두는 시간.
   *
   * 예전 기본값은 0 — **영원히** 였다. 붙잡아 두는 게 백그라운드 일꾼 하나뿐
   * 이라 손해가 없다고 봤는데, 그건 카드가 반드시 사람 눈에 닿는다는 가정
   * 위에서만 맞다. 탭을 닫아 뒀거나, 스트림이 끊겨 카드가 못 그려졌거나,
   * 그냥 자리를 비웠으면 그 사람은 "도구 실행 중" 인 채로 영영 굳는다.
   * 실제로 가장 잦은 멈춤이 이거였다.
   *
   * 그래서 유한하게 둔다. 시간이 다하면 approvalFallbackDecision 으로
   * 풀린다 — 'ask' 는 그 도구를 실행하지 않고 사람에게 말하라는 뜻이라,
   * 세션은 굳는 대신 말을 하고 멈춘다. 굳는 것과 말하고 멈추는 것은 다르다.
   */
  approvalHoldMs: 10 * 60 * 1000,
  approvalFallbackDecision: 'ask',
  holdOnlyWhenViewerConnected: false,

  /**
   * 무조건 물어볼 도구 이름. 비워 두는 것이 기본 —— 무엇을 물어볼지는
   * 목록이 아니라 src/risk.js 가 그때그때 판단한다 (되돌리기 어려운 변경 ·
   * 자격/개인정보 · 환경변수 노출). 목록으로 관리하고 싶은 사람만 쓴다.
   */
  askAlwaysTools: [],

  /**
   * 일하는 사람이 이만큼 아무 말이 없으면 화면에 "응답 없음" 이라고 적는다.
   * 죽이지는 않는다 — 오래 걸리는 빌드 하나가 여기 걸릴 수 있어서, 판단은
   * 사람 몫으로 둔다. 조용히 굳어 있는 것보다 굳었다고 말하는 게 낫다.
   */
  stalledAfterMs: 10 * 60 * 1000,

  /**
   * 그러고도 이만큼 더 조용하면 정말 굳은 것으로 보고 세션을 다시 띄운다.
   * 0 이면 안 한다. "굳었다고 적어 두기만" 하면 결국 사람이 손으로 살려야
   * 하는데, 그 손이 늘 거기 있지는 않다. 오래 걸리는 일 하나를 잘못 끊는
   * 값보다, 밤새 굳어 있는 값이 크다고 보고 25분으로 둔다.
   */
  hungAfterMs: 25 * 60 * 1000,

  /**
   * 끊긴 자리에서 하던 일을 이어서 하게 할 것인가.
   *
   * 사람이 대화창에 "계속 진행해" 를 손으로 치던 그 한 마디를 대신 건다.
   * 되살리기가 자리에 앉히는 데서 끝나면, 사람은 여전히 매번 돌아와서
   * 같은 말을 쳐 줘야 한다 — 그건 자동이 아니다.
   */
  autoContinue: true,

  /**
   * 하는 말이 무조건 Windows 알림으로도 나가는 유형.
   *
   * 유형 파일에 `notifyOnSpeak` 을 적을 수도 있지만, 기본값은 **여기** 있어야
   * 한다. 유형 폴더는 처음 켤 때 사용자 폴더로 복사되고 그 뒤로는 업데이트가
   * 덮지 않으므로, 유형 파일에만 적으면 새로 까는 사람에게만 켜지고 이미
   * 쓰고 있는 사람에게는 영영 안 켜진다.
   *
   * 토끼가 여기 있는 이유: 시간을 봐주는 사람의 말은 **자리를 비웠을 때**
   * 가장 필요한데, 대화창에만 적히면 정확히 그때 아무 데도 닿지 않는다.
   * 끄고 싶으면 그 유형의 persona.json 에 `"notifyOnSpeak": false`.
   */
  notifyOnSpeakPersonas: ['rabbit'],

  /**
   * 예기치 않게 죽은 사람을 몇 번까지 다시 앉힐 것인가. 자격이 만료된 상태
   * 같으면 뜨자마자 계속 죽으므로, 무한히 되살리면 그게 곧 무한 루프다.
   */
  reviveMaxAttempts: 3,
  reviveBackoffMs: 5000,

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
