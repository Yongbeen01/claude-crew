import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { bus, logActivity } from './bus.js';
import { gitBin } from './tools.js';

/**
 * Keeping everyone up to date without asking them to reinstall.
 *
 * The app has no dependencies to install, so an update is just "replace the
 * files and restart" — which is why this works at all. User data lives in
 * ~/.claude-crew and is never touched, so an update cannot lose a job history,
 * an edited persona, or a work log.
 */

const REPO = process.env.CREW_REPO_SLUG || 'Yongbeen01/claude-crew';
const BRANCH = process.env.CREW_BRANCH || 'main';

let status = { current: null, latest: null, behind: false, checkedAt: 0, error: '' };

/**
 * 사무실 쪽으로 나 있는 창구.
 *
 * update.js 가 crew.js 를 직접 부르면 "받기" 가 사무실을 알게 되고 그 반대도
 * 되어 서로 물린다. 필요한 건 세 가지 사실뿐이라 index.js 가 끼워 넣는다.
 */
let office = { busy: () => 0, seated: () => 0, shutdown: () => {} };
export function bindOffice(hooks) {
  office = { ...office, ...hooks };
}

/** 같은 실패를 30분마다 다시 적지 않기 위해. */
let lastAutoError = '';

function version() {
  if (status.current) return status.current;
  try {
    status.current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    status.current = '0.0.0';
  }
  return status.current;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, windowsHide: true, timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(err?.message ?? stderr ?? '') });
    });
  });
}

const isGitCheckout = () => fs.existsSync(path.join(ROOT, '.git'));

export function updateStatus() {
  return {
    ...status,
    current: version(),
    repo: REPO,
    branch: BRANCH,
    git: isGitCheckout(),
    // 화면이 띠 문구를 고르는 데 쓴다 — 알아서 받는 중인지, 눌러야 하는지.
    auto: config.autoUpdate !== false && canRestart(),
  };
}

/**
 * Is there anything newer? Compares the checked-out commit against the remote
 * branch head; falls back to the package.json version on GitHub for zip installs.
 */
export async function checkForUpdate() {
  status.checkedAt = Date.now();
  status.error = '';
  try {
    if (isGitCheckout()) {
      const fetched = await run(gitBin(), ['fetch', '--quiet', 'origin', BRANCH]);
      if (!fetched.ok) throw new Error(fetched.err.slice(0, 200));
      const local = (await run(gitBin(), ['rev-parse', 'HEAD'])).out.trim();
      const remote = (await run(gitBin(), ['rev-parse', `origin/${BRANCH}`])).out.trim();
      status.latest = remote.slice(0, 7);
      status.behind = !!local && !!remote && local !== remote;
    } else {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`);
      const remote = await res.json();
      status.latest = remote.version;
      status.behind = remote.version !== version();
    }
  } catch (err) {
    status.error = String(err.message).slice(0, 200);
    status.behind = false;
  }
  bus.emit('update', updateStatus());
  await maybeAutoUpdate();
  return updateStatus();
}

/**
 * 물어보지 않고 받아서 다시 켠다.
 *
 * 왜 물어보지 않아도 되게 됐는가: 예전에는 받기가 앉아 있던 사람들을 통째로
 * 끝냈다. 그래서 사람이 눌러야 했고, 안 누르면 그 컴퓨터만 옛 버전으로 굳었다.
 * 이제는 대화 그대로 돌아오므로(crew.revive) 눈치채지 못하는 사이에 지나가도
 * 되는 일이 됐다.
 *
 * 그래도 **일하는 사람이 있으면 손대지 않는다.** 대화는 돌아와도 지금 돌고
 * 있는 그 턴은 못 살리기 때문이다 — 다음 차례(30분 뒤)에 다시 본다.
 */
async function maybeAutoUpdate() {
  if (config.autoUpdate === false || !status.behind) return;
  // 받아만 놓고 스스로 못 켜면 돌고 있는 건 여전히 옛 코드다. 그건 조용히
  // 할 일이 아니라 사람에게 말할 일이라, 띠를 띄운 채로 둔다.
  if (!canRestart()) return;
  if (office.busy() > 0) return;

  const result = await applyAndRestart();
  if (result.ok) return;
  if (result.error && result.error !== lastAutoError) {
    lastAutoError = result.error;
    logActivity('error', `새 버전을 못 받았습니다 — ${result.error}`);
  }
}

/**
 * 받고, 앉은 사람들을 곱게 정리하고, 스스로 다시 켠다.
 *
 * 받기 버튼과 자동 업데이트가 **같은 이 길**을 지난다. 두 갈래로 두면 한쪽만
 * 고쳐지고, 그 한쪽은 아무도 안 눌러 보는 쪽이다.
 */
export async function applyAndRestart() {
  const result = await applyUpdate();
  if (!result.ok) return { ...result, restarting: false, revived: 0 };
  // 다시 켜기 전에 앉아 있는 사람들을 직접 정리한다. 재시작은 우리를 강제
  // 종료하므로 평소의 유예 시간이 돌기 전에 우리가 먼저 죽고, 그러면 claude
  // 프로세스가 부모 없이 남는다 (실제로 하나 남는 걸 봤다).
  //
  // 즉시 죽이지는 않는다. 이 사람들은 다시 켜지면 그대로 돌아오는데, 이어
  // 붙일 대화는 CLI 가 자기 파일에 적는 것이라 적을 틈은 줘야 한다. stdin 을
  // 닫고 1.5초 뒤 트리를 걷어내고, 그 다음에 앱을 다시 켠다 — 순서가 바뀌면
  // 다시 고아 프로세스다.
  const seated = office.seated();
  office.shutdown();
  const restarting = restartApp({ delayMs: 2200 });
  return { ...result, restarting, revived: seated };
}

/**
 * Pull the new files. The caller restarts — we don't restart ourselves, because
 * a person mid-task should be told first.
 */
export async function applyUpdate() {
  if (!isGitCheckout()) {
    return { ok: false, error: 'git 체크아웃이 아니라 자동 갱신이 안 됩니다. 설치 한 줄을 다시 실행해 주세요.' };
  }
  // 추적하는 파일이 고쳐졌을 때만 막는다.
  //
  // 예전에는 폴더 안에 **모르는 파일이 하나라도** 있으면 거절했다. 로그 한 장,
  // 스크린샷 한 장이 떨어져도 그때부터 그 컴퓨터는 영영 업데이트를 못 받고,
  // 화면에는 "직접 수정한 파일이 있습니다" 만 뜬다 — 짚어 주지도 않는다.
  // 덮어쓸 위험이 있는 건 고쳐진 추적 파일뿐이고, 새 파일과 이름이 부딪히면
  // 아래 merge 가 스스로 거절하며 그 이유를 말해 준다.
  // trim 을 먼저 하면 안 된다. porcelain 은 " M 파일" 처럼 상태 두 칸 뒤에
  // 공백 하나가 오는데, 통째로 trim 하면 **첫 줄의 앞 공백만** 사라져서 그
  // 줄만 정렬이 어긋난다 ("M src/x.js" 가 그대로 파일 이름이 된다).
  const dirty = (await run(gitBin(), ['status', '--porcelain', '--untracked-files=no'])).out;
  if (dirty.trim()) {
    const files = dirty.split('\n').filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim())
      .filter(Boolean).slice(0, 3).join(', ');
    return { ok: false, error: `앱 폴더에 직접 고친 파일이 있어 덮어쓰지 않았습니다: ${files}` };
  }
  // Fetch first, always.
  //
  // The merge below is against the *local* origin/<branch> ref, which only moves
  // when something fetches. Relying on the poll having done it means an apply
  // that arrives first merges a stale ref, changes nothing, and still reports
  // success — which is exactly what happened, and it looked like a deploy.
  const fetched = await run(gitBin(), ['fetch', 'origin', BRANCH, '--quiet']);
  if (!fetched.ok) return { ok: false, error: fetched.err.slice(0, 200) };

  const pulled = await run(gitBin(), ['merge', '--ff-only', `origin/${BRANCH}`]);
  if (!pulled.ok) return { ok: false, error: pulled.err.slice(0, 200) };

  logActivity('update', '새 버전을 받았습니다 — 다시 시작합니다');
  status.behind = false;
  bus.emit('update', updateStatus());
  return { ok: true, restartRequired: true, canRestart: canRestart() };
}

/** 스스로 다시 켤 방법이 있는가 (설치 스크립트가 깔아 둔 실행기). */
function canRestart() {
  return process.platform === 'win32'
    && fs.existsSync(path.join(ROOT, 'scripts', 'crew.vbs'))
    && fs.existsSync(path.join(ROOT, 'scripts', 'launch.ps1'));
}

/**
 * 받은 것을 실제로 적용한다 — 즉, 자기를 다시 켠다.
 *
 * 파일만 바꿔 놓고 "다시 시작하세요" 라고 말하는 것으로는 부족했다.
 * `src/*.js` 는 이미 메모리에 올라가 있어서, 받기를 눌러도 돌고 있는 것은
 * 옛 코드 그대로다. 받은 사람 눈에는 "배포했다는데 그대로" 로 보인다.
 *
 * 실행기(launch.ps1 -Restart)를 떼어내 띄우고 물러난다. 그 스크립트가 포트를
 * 잡고 있는 우리를 죽이고 새로 켠다 — 브라우저는 서버가 돌아오면 스스로
 * 새로고침한다.
 */
export function restartApp({ delayMs = 700 } = {}) {
  if (!canRestart()) return false;
  const vbs = path.join(ROOT, 'scripts', 'crew.vbs');
  setTimeout(() => {
    try {
      /*
       * 바탕화면 아이콘이 가는 길과 같은 길로 간다 (wscript → crew.vbs).
       *
       * powershell.exe 를 직접 부르는 건 두 번 다 실패했다.
       *  · detached 를 주면 콘솔 없이 떠서 아무 일도 안 하고 죽는다.
       *  · detached 없이 띄우면 우리 콘솔에 붙는데, 그 스크립트가 곧 우리를
       *    죽이므로 콘솔이 사라지면서 자기도 같이 죽는다 — 앱을 내려놓고
       *    다시 켜기 직전에 끊겼다.
       * wscript 는 콘솔이 없고, WScript.Shell.Run 이 띄우는 프로세스는
       * 우리와 무관하게 산다.
       */
      const child = spawn(
        'wscript.exe',
        [vbs, '-Restart', '-NoBrowser'],
        { stdio: 'ignore', windowsHide: true, cwd: ROOT },
      );
      child.unref();
    } catch { /* 못 켜면 사용자가 아이콘으로 켠다 */ }
  }, delayMs).unref?.();
  return true;
}

export function startUpdatePolling() {
  if (config.checkUpdates === false) return () => {};
  checkForUpdate();
  const every = Math.max(60_000, Number(config.updatePollMs) || 30 * 60 * 1000);
  const t = setInterval(checkForUpdate, every);
  t.unref?.();
  return () => clearInterval(t);
}
