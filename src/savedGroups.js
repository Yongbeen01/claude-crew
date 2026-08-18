import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { bus, logActivity } from './bus.js';
import { captureWindows, launchItems, desktopState } from './desktop.js';
import * as groups from './groups.js';

/**
 * A group of windows, kept after the windows are gone.
 *
 * A live group (groups.js) is a fact about what is open right now — close the
 * windows and it empties. A *saved* group is the opposite: a recipe. It holds
 * enough about each window to open it again tomorrow, so "월요일 마감" can be
 * one click on a machine that was rebooted since.
 *
 *   ~/.claude-crew/saved-groups.json
 *     [{ id, name, savedAt, items: [{ app, title, kind, exe, cmd, doc, url }] }]
 *
 * What we can and cannot keep, honestly:
 *   · a document you had open     — kept, and reopened BY the document, so
 *     Windows picks the app. This is the reliable path.
 *   · a Store app's document        — lost. The window belongs to a process
 *     whose command line does not name the file (verified with Win32_Process
 *     on the current Notepad); the app comes back empty.
 *   · the page a browser was on   — kept for the tab that was in FRONT
 *   · every other open tab        — not kept. Their addresses are not in the
 *     accessibility tree; only the omnibox is, and it shows one page.
 *   · a minimized browser         — no address either; its tree is not built
 *     until the window is restored. It comes back as the browser, no page.
 */

const FILE = path.join(DATA_DIR, 'saved-groups.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  } catch { /* a saved group is a convenience, not a record to fight the disk over */ }
}

export function listSaved() {
  return read()
    .slice()
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

export function getSaved(id) {
  return read().find((g) => g.id === id) ?? null;
}

function announce() {
  bus.emit('saved-groups', listSaved());
}

/**
 * Freeze a live group into a recipe.
 *
 * Tabs of one browser window share that window's handle, so they would each
 * capture the same address. They are collapsed to one entry per window — the
 * page in front — rather than five copies of it.
 */
export async function saveGroup(groupId, nameOverride) {
  const group = groups.listGroups().find((g) => g.id === groupId);
  if (!group) throw new Error('unknown group');

  const people = (desktopState().people ?? []).filter((p) => p.groupId === groupId);
  const hwnds = [...new Set(people.map((p) => p.hwnd).filter(Number.isFinite))];
  const captured = await captureWindows(hwnds);
  const byHwnd = new Map(captured.map((c) => [c.hwnd, c]));

  const items = [];
  const seenWindow = new Set();
  for (const p of people) {
    const c = byHwnd.get(p.hwnd) ?? {};
    // One entry per window. A browser window's five tabs would otherwise become
    // five identical recipes for the one page we can actually read.
    if (p.kind === 'tab') {
      if (seenWindow.has(p.hwnd)) continue;
      seenWindow.add(p.hwnd);
    }
    items.push({
      app: p.app ?? '',
      title: p.name ?? '',
      kind: p.kind ?? 'window',
      exe: c.exe ?? '',
      cmd: c.cmd ?? '',
      // 프로그램보다 문서를 여는 게 낫다 — 윈도가 알아서 맞는 앱을 고른다
      doc: c.doc ?? '',
      url: c.url ?? '',
    });
  }

  const list = read();
  const name = String(nameOverride ?? group.name ?? '').trim() || '이름 없는 그룹';
  // Saving the same group again replaces it rather than piling up copies.
  const existing = list.findIndex((g) => g.fromGroupId === groupId || g.name === name);
  const entry = {
    id: existing >= 0 ? list[existing].id : randomUUID().slice(0, 8),
    name,
    fromGroupId: groupId,
    savedAt: Date.now(),
    items,
  };
  if (existing >= 0) list[existing] = entry;
  else list.push(entry);
  write(list);
  announce();
  logActivity('info', `그룹 저장 — ${name} (${items.length}개)`);
  return entry;
}

export function renameSaved(id, name) {
  const list = read();
  const g = list.find((x) => x.id === id);
  if (!g) return null;
  g.name = String(name ?? '').trim() || g.name;
  write(list);
  announce();
  return g;
}

export function deleteSaved(id) {
  const list = read().filter((g) => g.id !== id);
  write(list);
  announce();
  return true;
}

/**
 * Open a saved group.
 *
 * Anything already on screen is left alone — re-running a recipe should fill in
 * what is missing, not hand you a second copy of the browser you are looking at.
 */
export async function openSaved(id) {
  const g = getSaved(id);
  if (!g) throw new Error('unknown saved group');

  const open = desktopState().people ?? [];
  const openTitles = new Set(open.map((p) => `${p.app}|${p.name}`));
  const openApps = new Set(open.map((p) => p.app));

  const wanted = g.items.filter((it) => {
    // That exact window is back already.
    if (openTitles.has(`${it.app}|${it.title}`)) return false;
    // We know *what* to open — a page or a document — so open it even though
    // its program is running; it becomes another tab or another document.
    if (it.url || it.doc) return true;
    // All we have is "run this program", and it is already running. Starting a
    // second empty copy of it helps nobody.
    return !openApps.has(it.app);
  });

  if (!wanted.length) {
    logActivity('info', `${g.name} — 이미 다 열려 있습니다`);
    return { ok: true, count: 0, skipped: g.items.length, failed: [] };
  }

  const res = await launchItems(wanted);
  const failed = res?.failed ?? [];
  const count = res?.count ?? 0;
  logActivity(
    failed.length ? 'error' : 'info',
    failed.length
      ? `${g.name} 열기 — ${count}개 열고 ${failed.length}개 실패: ${failed.slice(0, 2).join(', ')}`
      : `${g.name} 열기 — ${count}개`,
  );
  return {
    ok: !!res?.ok,
    count,
    skipped: g.items.length - wanted.length,
    failed,
    error: res?.error ?? null,
  };
}
