import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { bus } from './bus.js';

/**
 * The other half of the office: everything *you* have open.
 *
 * Each top-level window is one person, and a browser contributes one person per
 * tab rather than one per window — a browser window is a room full of people,
 * not a person. Together with the crew this is the whole of what is currently
 * demanding your attention, which is the thing worth seeing in one picture.
 *
 * All of it comes from one long-lived PowerShell host (scripts/desktop-host.ps1)
 * over JSON lines. Node has no way to enumerate windows on its own and this app
 * has no dependencies, so the shell is the API. Spawning it per poll cost ~600ms
 * of process start each time, hence the persistent child.
 */

const isWin = process.platform === 'win32';
const HOST = path.join(ROOT, 'scripts', 'desktop-host.ps1');

let child = null;
let ready = false;
let uia = false;
let seq = 0;
let restartAt = 0;
/** id -> {resolve, timer} */
const waiting = new Map();
/** hwnd -> last tabs seen, so a minimized browser keeps its people */
const tabCache = new Map();

let latest = { supported: isWin, uia: false, at: 0, people: [], error: null };

// ── process ───────────────────────────────────────────────────────────────
function spawnHost() {
  if (!isWin || child) return;
  // -File with forward slashes: the same argv rule the Runner learned. A
  // backslash path reaches PowerShell intact here, but staying consistent costs
  // nothing and the app has been bitten by it once already.
  child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', HOST.replace(/\\/g, '/'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { ready = true; uia = !!msg.uia; continue; }
      const pending = waiting.get(msg.id);
      if (!pending) continue;
      waiting.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  });

  child.stderr.on('data', (c) => {
    latest = { ...latest, error: c.toString('utf8').slice(-300) };
  });

  const gone = () => {
    child = null;
    ready = false;
    for (const [, p] of waiting) { clearTimeout(p.timer); p.resolve({ ok: false }); }
    waiting.clear();
    // Back off a little: a host that dies instantly must not become a spawn loop.
    restartAt = Date.now() + 5000;
  };
  child.on('error', gone);
  child.on('close', gone);
}

function ask(cmd, extra = {}, timeoutMs = 12_000) {
  if (!isWin) return Promise.resolve({ ok: false });
  if (!child && Date.now() >= restartAt) spawnHost();
  if (!child || !ready) return Promise.resolve({ ok: false });
  seq += 1;
  const id = seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false }); }, timeoutMs);
    waiting.set(id, { resolve, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
    } catch {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false });
    }
  });
}

// ── naming ────────────────────────────────────────────────────────────────
/** proc name -> what a human calls it. Anything unlisted keeps its own name. */
const APPS = {
  chrome: 'Chrome', msedge: 'Edge', whale: '웨일', brave: 'Brave', firefox: 'Firefox',
  vivaldi: 'Vivaldi', opera: 'Opera', arc: 'Arc',
  code: 'VS Code', 'code - insiders': 'VS Code', cursor: 'Cursor', devenv: 'Visual Studio',
  explorer: '파일 탐색기', notepad: '메모장', wordpad: '워드패드',
  excel: '엑셀', winword: '워드', powerpnt: '파워포인트', outlook: '아웃룩', onenote: '원노트',
  hwp: '한글', hword: '한글', acrord32: 'Acrobat', slack: '슬랙', kakaotalk: '카카오톡',
  discord: 'Discord', notion: 'Notion', figma: 'Figma', windowsterminal: '터미널',
  powershell: 'PowerShell', cmd: '명령 프롬프트', obsidian: 'Obsidian', teams: 'Teams',
  taskmgr: '작업 관리자', mspaint: '그림판', photos: '사진',
};

function appLabel(proc) {
  return APPS[String(proc ?? '').toLowerCase()] ?? (proc || '창');
}

/**
 * The person's name.
 *
 * A *window* title is "<what it is> - <what opened it>", sometimes several
 * levels deep, so the name is the first segment with the chrome stripped off:
 * the unsaved-changes marker, a browser's unread counter, Explorer's "and 3
 * more tabs".
 *
 * A *tab* title is not built that way — it is the page's own title, and cutting
 * it at the first separator turns "Kglowing | Dashboard" into "Kglowing". So
 * tabs keep everything and are only trimmed to fit.
 */
export function personName(title, proc, kind = 'window') {
  let name = String(title ?? '').trim()
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^[*•✻●]\s*/, '');
  if (kind !== 'tab') {
    name = (name.split(/\s+[-–—|·]\s+/)[0]?.trim() || name)
      .replace(/^[*•✻●]\s*/, '')
      .replace(/\s*(및|and)\s*\d+개?\s*(탭|tabs?)$/i, '')
      .trim();
  }
  if (!name) name = appLabel(proc);
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

/**
 * A second identity that survives the window being closed and opened again, so
 * a group does not quietly lose a member every time you restart an app. hwnd is
 * the primary key; this is what lets a fresh hwnd be re-adopted.
 */
function signature(kind, proc, name) {
  return `${kind}:${String(proc ?? '').toLowerCase()}:${name}`;
}

// ── polling ───────────────────────────────────────────────────────────────
function toPeople(windows, tabs) {
  const byWindow = new Map();
  for (const t of tabs ?? []) {
    const list = byWindow.get(t.hwnd) ?? [];
    list.push(t);
    byWindow.set(t.hwnd, list);
  }

  const people = [];
  for (const w of windows ?? []) {
    // A minimized browser reports no tabs (its tab strip is not realised), but
    // its people must not blink out of the office — that is exactly the state a
    // hidden group is in.
    const live = byWindow.get(w.hwnd);
    if (live?.length) tabCache.set(w.hwnd, live);
    const tabsFor = w.browser ? (live ?? tabCache.get(w.hwnd) ?? []) : [];

    if (tabsFor.length) {
      for (const t of tabsFor) {
        const name = personName(t.name, w.proc, 'tab');
        people.push({
          key: `tab:${t.rt}`,
          kind: 'tab',
          name,
          app: appLabel(w.proc),
          proc: w.proc,
          hwnd: w.hwnd,
          rt: t.rt,
          active: !!t.selected,
          minimized: !!w.minimized,
          sig: signature('tab', w.proc, name),
        });
      }
      continue;
    }

    const name = personName(w.title, w.proc);
    people.push({
      key: `win:${w.hwnd}`,
      kind: 'window',
      name,
      app: appLabel(w.proc),
      proc: w.proc,
      hwnd: w.hwnd,
      rt: null,
      active: false,
      minimized: !!w.minimized,
      sig: signature('win', w.proc, name),
    });
  }

  // Drop tab caches for windows that are gone, or the office fills up with
  // ghosts of closed browsers.
  const alive = new Set((windows ?? []).map((w) => w.hwnd));
  for (const hwnd of tabCache.keys()) if (!alive.has(hwnd)) tabCache.delete(hwnd);

  return people;
}

let onPeople = () => {};

/** groups.js hands us a decorator so people arrive already knowing their group. */
export function bindGroups(fn) {
  onPeople = fn;
}

export function desktopState() {
  return latest;
}

async function poll() {
  const res = await ask('list');
  if (!res?.ok) {
    latest = { ...latest, at: Date.now(), uia };
    return;
  }
  const people = onPeople(toPeople(res.windows, res.tabs)) ?? [];
  latest = { supported: true, uia: !!res.uia, at: Date.now(), people, error: null };
  bus.emit('desktop', latest);
}

export function startDesktopPolling() {
  if (!isWin || !config.desktop) {
    latest = { supported: false, uia: false, at: Date.now(), people: [], error: null };
    return () => {};
  }
  spawnHost();
  // First poll after the host has had a moment to load the UIA assemblies.
  setTimeout(poll, 1200).unref?.();
  const t = setInterval(poll, config.desktopPollMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Force a refresh now — after opening or hiding a group the picture is stale. */
export function refreshDesktop() {
  return poll();
}

// ── actions ───────────────────────────────────────────────────────────────
export function showWindows(hwnds) {
  const list = [...new Set(hwnds.filter(Number.isFinite))];
  if (!list.length) return Promise.resolve({ ok: true, count: 0 });
  return ask('show', { windows: list }, 20_000);
}

export function hideWindows(hwnds) {
  const list = [...new Set(hwnds.filter(Number.isFinite))];
  if (!list.length) return Promise.resolve({ ok: true, count: 0 });
  return ask('hide', { windows: list }, 20_000);
}

/** Bring one person to the front — for a tab, select it inside its window. */
export function focusPerson({ hwnd, rt }) {
  if (!Number.isFinite(hwnd)) return Promise.resolve({ ok: false });
  return ask('focus', { hwnd, rt: rt ?? null });
}

export function shutdownDesktop() {
  if (!child) return;
  try { child.stdin.write('{"cmd":"quit"}\n'); } catch { /* already gone */ }
  const c = child;
  setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 800).unref?.();
}
