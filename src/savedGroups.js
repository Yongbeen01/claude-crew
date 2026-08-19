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
      // 어느 창에서 온 항목인지 적어 둔다. 이게 없으면 나중에 그룹이 바뀌었을
      // 때 무엇이 새로 들어오고 무엇이 빠졌는지 맞춰 볼 수가 없다.
      key: p.key ?? '',
      sig: p.sig ?? '',
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

/**
 * 저장해 둔 그룹을 살아 있는 그룹에 맞춘다.
 *
 * 예전에는 저장 버튼을 누른 그 순간이 통째로 굳었다. 그 뒤로 창을 하나 더
 * 끌어다 넣어도 저장본은 모른 채였고, 다음 주에 열면 그때 그 창들만 떴다.
 *
 * **닫힌 창은 지우지 않는다.** 이 목록의 쓸모가 바로 "다 닫은 뒤에 다시
 * 여는 것" 이라, 퇴근하며 창을 닫았다고 조리법이 비어 버리면 안 된다.
 * 빠지는 건 그룹 밖으로 끌어낸 창뿐이다 — 그건 배정이 사라지므로 구별된다.
 *
 * @returns {Promise<object|null>} 바뀐 저장본, 건드릴 게 없으면 null
 */
export async function syncFromGroup(groupId) {
  if (!groupId) return null;
  const list = read();
  const idx = list.findIndex((g) => g.fromGroupId === groupId);
  if (idx < 0) return null;           // 저장해 둔 적 없는 그룹이면 할 일이 없다

  const prev = list[idx];
  const people = (desktopState().people ?? []).filter((p) => p.groupId === groupId);
  const openKeys = new Set(people.map((p) => p.key));

  // 지금 열려 있는 것들은 새로 훑어 온다 (제목·주소가 그새 달라졌을 수 있다)
  const hwnds = [...new Set(people.map((p) => p.hwnd).filter(Number.isFinite))];
  const captured = await captureWindows(hwnds);
  const byHwnd = new Map(captured.map((c) => [c.hwnd, c]));

  const items = [];
  const seenWindow = new Set();
  for (const p of people) {
    const c = byHwnd.get(p.hwnd) ?? {};
    if (p.kind === 'tab') {
      if (seenWindow.has(p.hwnd)) continue;
      seenWindow.add(p.hwnd);
    }
    items.push({
      key: p.key ?? '',
      sig: p.sig ?? '',
      app: p.app ?? '',
      title: p.name ?? '',
      kind: p.kind ?? 'window',
      exe: c.exe ?? '',
      cmd: c.cmd ?? '',
      doc: c.doc ?? '',
      url: c.url ?? '',
    });
  }

  /*
   * 빠진 창과 그냥 닫힌 창을 가른다. 둘 다 "이 그룹에 안 보인다" 는 점은
   * 같지만 뜻이 정반대다.
   *
   *   · 화면 어딘가에 열려 있는데 이 그룹이 아니다 → 끌어낸 것. 뺀다.
   *   · 아예 열려 있지 않다 → 그냥 닫은 것. 데리고 간다.
   *
   * 이 구별이 없으면 퇴근하며 창을 다 닫는 순간 조리법이 비어 버린다 —
   * 하필 그게 이 목록이 가장 쓸모 있어야 할 순간이다.
   */
  const openAnywhere = new Set((desktopState().people ?? []).map((p) => p.key));
  for (const old of prev.items ?? []) {
    if (!old.key) { items.push(old); continue; }     // key 없던 시절 것 — 버리지 않는다
    if (openKeys.has(old.key)) continue;             // 위에서 새로 담았다
    if (openAnywhere.has(old.key)) continue;         // 그룹 밖으로 끌어냈다
    items.push(old);                                 // 닫혀 있을 뿐이다
  }

  const same = JSON.stringify(prev.items) === JSON.stringify(items);
  if (same) return null;

  list[idx] = { ...prev, items, savedAt: Date.now() };
  write(list);
  announce();
  return list[idx];
}

/**
 * 맞출 필요가 있는지 값싸게 먼저 본다.
 *
 * syncFromGroup 은 창 정보를 다시 훑느라 PowerShell 을 부른다. 창 목록은
 * 몇 초마다 갱신되므로, 달라진 게 없는데도 매번 훑으면 그 비용이 계속 든다.
 * 창이 들고 난 것만 여기서 가려낸다.
 */
function membershipChanged(saved) {
  const people = desktopState().people ?? [];
  const live = people.filter((p) => p.groupId === saved.fromGroupId).map((p) => p.key);
  const known = new Set((saved.items ?? []).map((i) => i.key).filter(Boolean));
  if (live.some((k) => !known.has(k))) return true;              // 새로 들어온 창

  const openAnywhere = new Set(people.map((p) => p.key));
  const inGroup = new Set(live);
  // 열려 있는데 이 그룹이 아니게 된 항목 = 끌어낸 것
  return (saved.items ?? []).some((i) => i.key && openAnywhere.has(i.key) && !inGroup.has(i.key));
}

/** 살아 있는 그룹과 짝지어 둔 저장본이 있으면 전부 맞춘다. */
export async function syncAllLinked() {
  const live = new Set(groups.listGroups().map((g) => g.id));
  for (const saved of read()) {
    if (!saved.fromGroupId || !live.has(saved.fromGroupId)) continue;
    if (!membershipChanged(saved)) continue;
    await syncFromGroup(saved.fromGroupId);
  }
}

/*
 * 창 목록이 움직일 때마다 따라간다.
 *
 * 창을 끌어다 넣는 것도, 닫았다 다시 열어 제자리를 찾아가는 것도 전부 이
 * 신호로 온다. 잠깐 몰아서 처리한다 — 창 하나 옮기는 사이에도 이 신호는
 * 여러 번 튄다.
 */
let syncTimer = null;
bus.on('desktop', () => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncAllLinked().catch(() => { /* 맞추기는 편의지 기록이 아니다 */ });
  }, 1500);
  syncTimer.unref?.();
});

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
