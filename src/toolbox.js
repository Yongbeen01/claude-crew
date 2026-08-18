import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { bus, logActivity } from './bus.js';

/**
 * A shared toolbox of npm packages every person can reach.
 *
 * Claude Code — unlike claude.ai — ships no document skills, so 디자이너 and
 * 표고버섯 build real .pptx / .xlsx files with npm packages. Left to itself each
 * person would `npm install` into its own folder on every task: slow, repeated,
 * and dead in the water behind a corporate proxy.
 *
 * Instead we install once into ~/.claude-crew/toolbox and link each person's
 * work folder at it. On Windows the link is a directory *junction*, which needs
 * no admin rights (verified) and which Node's ESM resolver follows, so
 * `import pptxgenjs from 'pptxgenjs'` just works inside a session folder.
 */

export const TOOLBOX_DIR = path.join(DATA_DIR, 'toolbox');
const MODULES_DIR = path.join(TOOLBOX_DIR, 'node_modules');

/**
 * `docs` is for everyone and is fetched at startup. `video` is 80MB of ffmpeg
 * and a yt-dlp binary that only 영화감독 has any use for, so it waits until one
 * is actually hired — nobody who never calls one should pay that download.
 */
const GROUPS = {
  docs: ['pptxgenjs', 'xlsx', 'exceljs'],
  video: ['youtube-dl-exec', 'ffmpeg-static'],
};

/** Where a group's binaries land, once it is installed. */
export const BINARIES = {
  ytdlp: path.join(MODULES_DIR, 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ffmpeg: path.join(MODULES_DIR, 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
};

let state = { ready: false, installing: false, error: '', packages: GROUPS.docs, groups: {} };
/** one install per group at a time — a second hire must not start a second npm */
const inFlight = new Map();

export function toolboxStatus() {
  return { ...state };
}

function groupInstalled(group) {
  return (GROUPS[group] ?? []).every((p) => fs.existsSync(path.join(MODULES_DIR, p, 'package.json')));
}

function installed() {
  return groupInstalled('docs');
}

function publish() {
  state = {
    ...state,
    ready: installed(),
    groups: Object.fromEntries(Object.keys(GROUPS).map((g) => [g, groupInstalled(g)])),
  };
  bus.emit('toolbox', toolboxStatus());
}

function writePackageJson() {
  fs.mkdirSync(TOOLBOX_DIR, { recursive: true });
  const pkgFile = path.join(TOOLBOX_DIR, 'package.json');
  if (fs.existsSync(pkgFile)) return;
  fs.writeFileSync(pkgFile, JSON.stringify({
    name: 'claude-crew-toolbox',
    private: true,
    description: '사람들이 문서를 만들 때 쓰는 공용 패키지. 앱이 관리합니다.',
    type: 'module',
  }, null, 2), 'utf8');
}

function npmInstall(packages) {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel', 'error', ...packages],
      {
        cwd: TOOLBOX_DIR,
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 1 << 22,
        shell: process.platform === 'win32',
        // youtube-dl-exec's preinstall refuses to run without Python, even
        // though what it fetches on Windows is a standalone yt-dlp.exe that
        // never needs one (verified — the binary runs and reports its version).
        env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' },
      },
      (err) => resolve(err),
    );
  });
}

/**
 * Fetch one group if it isn't there. Best effort in every case: a failure only
 * means the person falls back to what its skill says to do without the tool.
 *
 * @returns {Promise<boolean>} whether the group is usable now
 */
export function ensureGroup(group) {
  if (!GROUPS[group]) return Promise.resolve(false);
  if (groupInstalled(group)) { publish(); return Promise.resolve(true); }
  if (config.toolbox === false) return Promise.resolve(false);
  if (inFlight.has(group)) return inFlight.get(group);

  writePackageJson();
  state = { ...state, installing: true, error: '' };
  logActivity('toolbox', group === 'video'
    ? '영상 도구를 받는 중입니다 (처음 한 번만 걸립니다)'
    : '문서 도구를 준비합니다 (처음 한 번만 걸립니다)');
  publish();

  const job = npmInstall(GROUPS[group]).then((err) => {
    const ok = groupInstalled(group);
    state = {
      ...state,
      installing: false,
      error: ok ? '' : String(err?.message ?? '설치하지 못했습니다').slice(0, 200),
    };
    logActivity(
      ok ? 'toolbox' : 'error',
      ok
        ? (group === 'video'
          ? '영상 도구 준비 완료 — 영상 파일과 링크를 열어 볼 수 있습니다'
          : '문서 도구 준비 완료 — PPT·엑셀을 바로 만들 수 있습니다')
        : `도구를 못 받았습니다 (${state.error.slice(0, 60)}) — 사람들이 필요할 때 직접 받습니다`,
    );
    publish();
    inFlight.delete(group);
    return ok;
  });
  inFlight.set(group, job);
  return job;
}

/**
 * Install the everyone-packages if they aren't there. Runs in the background at
 * startup — nothing waits on it.
 */
export function ensureToolbox() {
  return ensureGroup('docs').then(() => toolboxStatus());
}

/**
 * Point one person's work folder at the shared toolbox. Best effort: if the
 * link can't be made, the session still works — its skill falls back to
 * installing what it needs itself.
 *
 * The link is to the directory, not a copy, so a group installed *after* this
 * person sat down shows up in their folder without relinking.
 */
export function linkInto(workdir) {
  if (!fs.existsSync(MODULES_DIR)) return false;
  const target = path.join(workdir, 'node_modules');
  try {
    if (fs.existsSync(target)) return true;
    fs.mkdirSync(workdir, { recursive: true });
    // 'junction' on Windows needs no elevation; 'dir' elsewhere.
    fs.symlinkSync(MODULES_DIR, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}
