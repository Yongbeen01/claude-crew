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
  return { ...status, current: version(), repo: REPO, branch: BRANCH, git: isGitCheckout() };
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
  return updateStatus();
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
  const dirty = (await run(gitBin(), ['status', '--porcelain', '--untracked-files=no'])).out.trim();
  if (dirty) {
    // 앞의 상태 두 글자와 공백을 떼어 낸다. 고정 폭으로 자르면 파일 이름이
    // 한 글자씩 잘려 나온다 ("src/update.js" 가 "rc/update.js" 로).
    const files = dirty.split('\n').map((l) => l.replace(/^.{2}\s+/, '').trim())
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
  return fs.existsSync(path.join(ROOT, 'scripts', 'launch.ps1'));
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
  const script = path.join(ROOT, 'scripts', 'launch.ps1');
  setTimeout(() => {
    try {
      // detached 를 주면 안 된다. 윈도우에서 그건 "콘솔 없이" 라는 뜻이고,
      // 콘솔 없이 뜬 powershell.exe 는 아무 일도 안 하고 그냥 죽는다 —
      // 여섯 가지 조합을 만들어 재 보고서야 알았다. 떼어내지 않아도 부모가
      // 사라진 자식은 윈도우에서 그대로 살아남으므로 이걸로 충분하다.
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Restart', '-NoBrowser'],
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
  const t = setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  t.unref?.();
  return () => clearInterval(t);
}
