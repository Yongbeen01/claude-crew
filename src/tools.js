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
      windowsHide: true, timeout: 20_000, env: process.env,
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
 */
export function authLogin() {
  const bin = claudeBin();
  if (process.platform !== 'win32') {
    spawn(bin, ['auth', 'login'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  // cmd 창 하나를 띄워 그 안에서 돌린다. 로그인 절차가 그 창에 나온다.
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/wait', 'cmd', '/c', `"${bin}" auth login & pause`], {
    stdio: 'ignore', windowsHide: false, shell: false,
  });
  child.unref();
  return true;
}

export function authLogout() {
  return new Promise((resolve) => {
    const a = claudeArgv(['auth', 'logout']);
    execFile(a.cmd, a.args, {
      windowsHide: true, timeout: 30_000, env: process.env,
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
