import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HOME, config } from './config.js';
import { bus } from './bus.js';

/**
 * 앱이 부리는 두 개의 바깥 프로그램 — `claude` 와 `git` — 이 어디 있는지.
 *
 * 예전에는 이름만 넘기고 PATH 에 맡겼다. 설치한 사람 컴퓨터에서는 그게 잘
 * 됐는데, 그건 설치 스크립트가 자기 세션의 PATH 를 고쳐 놨기 때문이었다.
 * 남의 컴퓨터에서 바탕화면 아이콘으로 켜면 그 PATH 가 없다. 그러면:
 *
 *   · 세션이 뜨자마자 죽어 "종료됨" 으로 보인다 (로그아웃처럼 보이는 정체)
 *   · 남은 한도 칸이 비어 있다
 *   · 업데이트 확인이 조용히 실패해 "받기" 띠가 영영 안 뜬다
 *
 * 셋 다 같은 원인이고, 화면에는 서로 다른 고장으로 보인다. 그래서 PATH 에
 * 기대지 않고 우리가 직접 찾아 **절대 경로**로 부른다. 찾은 폴더는
 * process.env.PATH 앞에 붙여 두어, 자식 프로세스와 claude 가 다시 부르는
 * 것들도 같은 길을 쓰게 한다.
 */

const isWin = process.platform === 'win32';
const exe = (p) => (isWin ? [`${p}.exe`, `${p}.cmd`, `${p}.bat`, p] : [p]);

/** 설치 방식마다 다른, 흔히 놓이는 자리들. */
function candidates(name) {
  const out = [];
  const add = (...parts) => out.push(path.join(...parts));
  if (name === 'claude') {
    add(HOME, '.local', 'bin');
    add(HOME, 'AppData', 'Local', 'Programs', 'claude');
    add(HOME, 'AppData', 'Roaming', 'npm');          // npm -g 로 깔았을 때
    add(HOME, '.bun', 'bin');
    add('/usr/local/bin');
  } else if (name === 'git') {
    add(DATA_DIR, 'runtime', 'git', 'cmd');          // 설치 스크립트가 받아 둔 무설치본
    add('C:', '\\Program Files', 'Git', 'cmd');
    add('C:', '\\Program Files (x86)', 'Git', 'cmd');
    add(HOME, 'AppData', 'Local', 'Programs', 'Git', 'cmd');
    add('/usr/bin');
  } else if (name === 'node') {
    add(DATA_DIR, 'runtime', 'node');
  }
  return out;
}

/** PATH 에 있으면 그걸 쓴다 — 사용자가 직접 깐 것을 앞지르지 않는다. */
function onPath(name) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], {
      windowsHide: true, timeout: 5000, encoding: 'utf8',
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function search(name) {
  const found = onPath(name);
  if (found) return found;
  for (const dir of candidates(name)) {
    for (const file of exe(name)) {
      const full = path.join(dir, file);
      try { if (fs.existsSync(full)) return full; } catch { /* 접근 못 하면 다음 자리 */ }
    }
  }
  return null;
}

const cache = new Map();

/**
 * 이 프로그램의 절대 경로. 못 찾으면 이름을 그대로 돌려준다 — 그때는 예전처럼
 * PATH 에 걸어 보기라도 하는 편이 아무것도 안 하는 것보다 낫다.
 */
export function bin(name) {
  const hit = cache.get(name);
  // 캐시가 가리키던 파일이 사라졌으면(업데이트·재설치) 다시 찾는다
  if (hit && (hit === name || fs.existsSync(hit))) return hit;

  const override = name === 'claude' && process.env.CLAUDE_BIN ? process.env.CLAUDE_BIN : null;
  const found = override ?? search(name) ?? name;
  cache.set(name, found);

  // 찾은 폴더를 PATH 앞에 붙인다. claude 가 자기 하위 도구를 부를 때도 같은
  // 길을 쓰게 하려는 것 — 자식은 process.env 를 물려받는다.
  if (found !== name) {
    const dir = path.dirname(found);
    const sep = isWin ? ';' : ':';
    const parts = String(process.env.PATH ?? '').split(sep);
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) {
      process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`;
    }
  }
  return found;
}

export const claudeBin = () => bin('claude');
export const gitBin = () => bin('git');

/**
 * claude 를 부르는 올바른 방법.
 *
 * npm 으로 깐 컴퓨터에서는 claude 가 `.cmd` 껍데기다. execFile 은 그걸 직접
 * 못 돌리고 EINVAL 을 **동기로 던진다** — 그 바람에 앱이 부팅 도중 통째로
 * 죽었다(가짜 claude 를 물려 보고서야 봤다).
 *
 * 그럴 때는 cmd.exe 에게 맡긴다. shell:true 로 붙이지 않는 이유는 인자를
 * 이어 붙이기 때문이다 — 경로에 공백이 하나만 있어도 명령이 쪼개진다.
 * 이렇게 하면 인자는 Node 가 알아서 따옴표 쳐 준다.
 */
export function claudeArgv(args) {
  const p = claudeBin();
  return /\.(cmd|bat)$/i.test(p) ? { cmd: 'cmd.exe', args: ['/c', p, ...args] } : { cmd: p, args };
}

/**
 * 우리가 `claude` 를 부를 때 물려주는 환경.
 *
 * 일하는 사람들(runner)은 과금 경로로 새지 않도록 이 값들을 지운 채로 뜬다.
 * 그런데 계정 확인·로그인은 지우지 않은 채로 부르고 있었다 — 그러면 둘이
 * **서로 다른 자격을 보고** 서로 다른 답을 한다:
 *
 *   · 화면의 계정 버튼: 환경변수 API 키를 보고 "로그인됨"
 *   · 실제 세션: 그 키가 지워진 채라 "failed to authenticate"
 *
 * 로그인은 됐다는데 아무도 일을 못 하는 그 상태가 여기서 나온다. 물어보는
 * 쪽과 일하는 쪽이 같은 것을 보게 맞춘다.
 */
export function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * 지금 누구로 로그인돼 있는가.
 *
 * `claude auth status` 는 JSON 을 준다. 문장에서 낱말을 찾으면 안 된다 —
 * 설치 스크립트가 그렇게 했다가, 로그인 안 한 사람만 로그인 단계를 건너뛰고
 * 앱이 조용히 안 되는 일을 겪었다.
 */
let auth = { loggedIn: null, email: '', plan: '', method: '', checkedAt: 0 };
let authInFlight = null;

/**
 * 캐시된 값을 그대로 준다. 이 함수는 /api/state 마다 불리는데, 매번 CLI 를
 * 부르면 (1초쯤 걸린다) 서버가 그때마다 멈춘다. 낡았으면 뒤에서 갱신만 걸고
 * 지금 아는 값을 돌려준다.
 */
export function authStatus({ maxAgeMs = 60_000 } = {}) {
  if (Date.now() - auth.checkedAt > maxAgeMs) refreshAuth();
  return { ...auth };
}

/** 실제로 물어본다. 겹쳐 부르지 않는다. */
export function refreshAuth() {
  if (authInFlight) return authInFlight;
  authInFlight = new Promise((resolve) => {
    const a = claudeArgv(['auth', 'status']);
    execFile(a.cmd, a.args, {
      windowsHide: true, timeout: 20_000, env: cliEnv(),
    }, (err, stdout) => {
      authInFlight = null;
      let next = { loggedIn: false, email: '', plan: '', method: '', checkedAt: Date.now() };
      try {
        const j = JSON.parse(String(stdout));
        next = {
          loggedIn: !!j.loggedIn,
          email: j.email ?? '',
          plan: j.subscriptionType ?? '',
          method: j.authMethod ?? '',
          checkedAt: Date.now(),
        };
      } catch {
        next.error = String(err?.message ?? '').slice(0, 120);
      }
      const changed = next.loggedIn !== auth.loggedIn || next.email !== auth.email;
      auth = next;
      if (changed) bus.emit('auth', { ...auth });
      resolve({ ...auth });
    });
  });
  return authInFlight;
}

/**
 * 로그인·로그아웃.
 *
 * 로그인은 브라우저를 띄우고 사람이 끝낼 때까지 기다리는 일이라, 창 없이
 * 돌리면 아무 일도 안 일어난 것처럼 보인다. **보이는 창**으로 띄워서 사람이
 * 무슨 일이 벌어지는지 보고 끝낼 수 있게 한다.
 *
 * 그 창을 띄우는 법이 문제였다. 예전에는 명령을 통째로 인자에 담아
 * `cmd /c start "" /wait cmd /c "…claude… auth login & pause"` 로 넘겼는데,
 * Node 는 인자 안의 따옴표를 `\"` 로 바꿔 내보내고 cmd.exe 는 백슬래시를
 * 탈출문자로 **안** 친다. 그래서 cmd 가 보는 명령줄은 따옴표 짝이 어긋난
 * 다른 문장이 되고, start 는 없는 프로그램을 부르다 만다 — 창이 떴다가
 * 그대로 닫히고, 로그인은 시작조차 안 된다. `pause` 도 그 문장 안에 있으니
 * 같이 날아가서, 무엇이 잘못됐는지 볼 새도 없다.
 *
 * 그래서 명령을 인자에 담지 않는다. 할 일을 작은 .cmd 파일에 적어 두고
 * 그 **파일 하나만** 부른다. 인용이 한 겹으로 줄어드니 어긋날 짝이 없다.
 */
const LOGIN_SCRIPT = path.join(DATA_DIR, 'auth-login.cmd');

/**
 * 로그인 창이 할 일. 파일 안은 **글자 그대로 ASCII 만** 쓴다.
 *
 * 배치 파일은 콘솔 코드페이지로 읽힌다. claude 가 놓인 경로를 여기 적어 두면
 * 사용자 이름이 한글인 사람(`C:\Users\홍길동\…`)에게서 그 줄이 깨져 읽히고,
 * 창은 "파일을 찾을 수 없습니다" 만 남기고 만다. 그래서 경로는 파일이 아니라
 * **환경변수로** 넘긴다 — 환경변수는 코드페이지를 거치지 않는다.
 *
 * 창에 뜨는 안내가 영어인 것도 같은 이유다. 한국어 Windows 의 기본 콘솔
 * 글꼴은 UTF-8 한글을 네모로 그린다. 한국어 안내는 글자가 제대로 나오는 앱
 * 화면이 맡고, 이 창은 claude 가 하는 말만 있는 그대로 보여 준다.
 */
function writeLoginScript() {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',                       // claude 가 그리는 상자 문자가 깨지지 않게
    'title Claude Code - sign in',
    'echo.',
    'echo   Signing in to Claude Code.',
    'echo   Finish in the browser, then come back here.',
    'echo.',
    // `call` 이 꼭 필요하다. npm 으로 깐 claude 는 `.cmd` 껍데기인데, 배치
    // 파일에서 다른 배치 파일을 call 없이 부르면 **제어가 돌아오지 않는다**.
    // 그러면 아래 pause 까지 못 오고 창이 그대로 닫힌다 — 고치려던 그 증상이
    // 그대로 다시 난다.
    'call "%CREW_CLAUDE_BIN%" auth login',
    'set CREW_RC=%ERRORLEVEL%',
    'echo.',
    'if "%CREW_RC%"=="0" echo   Done. You can close this window.',
    'if not "%CREW_RC%"=="0" echo   Sign-in did not finish. Exit code %CREW_RC%.',
    'echo.',
    'pause',
    '',
  ];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOGIN_SCRIPT, lines.join('\r\n'), 'ascii');
}

export function authLogin() {
  const bin = claudeBin();
  // 못 찾았으면 창을 띄워 봐야 같은 PATH 로 또 못 찾는다. 빈 창을 던져 주고
  // 사람이 무엇이 잘못됐는지 짐작하게 두느니, 화면에 사실대로 적는다.
  if (bin === 'claude') {
    return { ok: false, error: 'claude 를 찾지 못했습니다. Claude Code 를 설치한 뒤 다시 시도해 주세요.' };
  }

  if (process.platform !== 'win32') {
    spawn(bin, ['auth', 'login'], { detached: true, stdio: 'ignore', env: cliEnv() }).unref();
    return { ok: true, started: true };
  }

  try {
    writeLoginScript();
  } catch (e) {
    return { ok: false, error: `로그인 창을 준비하지 못했습니다 — ${String(e.message).slice(0, 120)}` };
  }

  // windowsVerbatimArguments: 명령줄을 우리가 적은 그대로 내보낸다. Node 가
  // 따옴표를 손대는 순간 위에 적은 그 고장이 다시 난다.
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/wait', `"${LOGIN_SCRIPT}"`], {
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
    windowsVerbatimArguments: true,
    // 자격은 세션과 똑같은 자리에서 찾게 한다 — 여기서 환경변수 키를 남겨 두면
    // 로그인 창은 성공했다는데 정작 일하는 사람들은 못 붙는 상태가 만들어진다.
    env: { ...cliEnv(), CREW_CLAUDE_BIN: bin },
  });
  // 창이 닫혔다 = 사람이 끝냈다. 화면이 물어보기를 기다리지 말고 바로 확인한다.
  child.on('close', () => { refreshAuth(); });
  child.on('error', () => { /* 아래 폴링이 어차피 사실을 말한다 */ });
  child.unref();
  return { ok: true, started: true };
}

export function authLogout() {
  return new Promise((resolve) => {
    const a = claudeArgv(['auth', 'logout']);
    execFile(a.cmd, a.args, {
      windowsHide: true, timeout: 30_000, env: cliEnv(),
    }, async (err) => {
      // 결과를 짐작하지 않고 다시 물어본다 — 화면에 뜨는 건 이 값이다.
      const now = await refreshAuth();
      resolve(err && now.loggedIn
        ? { ok: false, error: String(err.message).slice(0, 160), auth: now }
        : { ok: true, auth: now });
    });
  });
}

/** 찾았는지 못 찾았는지 — 화면이 사실대로 말할 수 있게. */
export function toolsStatus() {
  const claude = bin('claude');
  const git = bin('git');
  return {
    claude: { found: claude !== 'claude', path: claude === 'claude' ? '' : claude },
    git: { found: git !== 'git', path: git === 'git' ? '' : git },
    configured: config.claudeBin !== 'claude' ? config.claudeBin : '',
    auth: authStatus(),
  };
}
