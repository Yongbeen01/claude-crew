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

/** Packages the shipped personas rely on. */
const PACKAGES = ['pptxgenjs', 'xlsx', 'exceljs'];

let state = { ready: false, installing: false, error: '', packages: PACKAGES };

export function toolboxStatus() {
  return { ...state };
}

function installed() {
  return PACKAGES.every((p) => fs.existsSync(path.join(MODULES_DIR, p, 'package.json')));
}

/**
 * Install the toolbox if it isn't there. Runs in the background at startup —
 * nothing waits on it, and a failure only means the person falls back to
 * installing per-task (or to handing back markdown, as its skill says).
 */
export function ensureToolbox() {
  if (state.installing || installed()) {
    state = { ...state, ready: installed(), installing: false };
    return Promise.resolve(state);
  }
  if (config.toolbox === false) return Promise.resolve(state);

  fs.mkdirSync(TOOLBOX_DIR, { recursive: true });
  const pkgFile = path.join(TOOLBOX_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify({
      name: 'claude-crew-toolbox',
      private: true,
      description: '사람들이 문서를 만들 때 쓰는 공용 패키지. 앱이 관리합니다.',
      type: 'module',
    }, null, 2), 'utf8');
  }

  state = { ...state, installing: true, error: '' };
  logActivity('toolbox', '문서 도구를 준비합니다 (처음 한 번만 걸립니다)');
  bus.emit('toolbox', toolboxStatus());

  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel', 'error', ...PACKAGES],
      { cwd: TOOLBOX_DIR, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1 << 22, shell: process.platform === 'win32' },
      (err) => {
        const ok = installed();
        state = {
          ...state,
          ready: ok,
          installing: false,
          error: ok ? '' : String(err?.message ?? '설치하지 못했습니다').slice(0, 200),
        };
        logActivity(
          ok ? 'toolbox' : 'error',
          ok ? '문서 도구 준비 완료 — PPT·엑셀을 바로 만들 수 있습니다'
             : `문서 도구를 못 받았습니다 (${state.error.slice(0, 60)}) — 사람들이 필요할 때 직접 받습니다`,
        );
        bus.emit('toolbox', toolboxStatus());
        resolve(state);
      },
    );
  });
}

/**
 * Point one person's work folder at the shared toolbox. Best effort: if the
 * link can't be made, the session still works — its skill falls back to
 * installing what it needs itself.
 */
export function linkInto(workdir) {
  if (!installed()) return false;
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
