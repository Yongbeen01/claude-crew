import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus, logActivity } from './bus.js';
import { readJson, writeJson } from './store.js';
import {
  bindGroups, desktopState, hideWindows, showWindows, refreshDesktop,
} from './desktop.js';

/**
 * Grouping the windows you have open.
 *
 * One piece of work is never one window: it is a spreadsheet, two tabs of
 * documentation and a chat thread. A group is that set, named, and openable or
 * hideable in one press — which is the only reason to draw them as people
 * sitting around a table rather than as a list.
 *
 *   ~/.claude-crew/groups.json
 *     groups   [{ id, name, hidden, createdAt }]
 *     members  key -> groupId          (hwnd / tab runtime id — exact)
 *     sigs     signature -> groupId    (app + name — survives a restart)
 *
 * `sigs` is why a group does not slowly empty out: close the spreadsheet and
 * open it again tomorrow and it walks back to the same table on its own.
 */

const FILE = path.join(DATA_DIR, 'groups.json');

function load() {
  const raw = readJson(FILE, null);
  return {
    groups: Array.isArray(raw?.groups) ? raw.groups : [],
    members: raw?.members && typeof raw.members === 'object' ? raw.members : {},
    sigs: raw?.sigs && typeof raw.sigs === 'object' ? raw.sigs : {},
  };
}

let state = load();
/** The last decorated snapshot — what a group's members actually are right now. */
let people = [];

function save() {
  writeJson(FILE, state);
}

function announce() {
  bus.emit('groups', listGroups());
}

export function listGroups() {
  const counts = new Map();
  for (const p of people) {
    if (!p.groupId) continue;
    counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1);
  }
  return state.groups.map((g) => ({
    ...g,
    count: counts.get(g.id) ?? 0,
    // "hidden" is a fact about the windows, not a flag we get to keep: the user
    // can restore any of them by hand and the button has to agree with reality.
    hidden: membersOf(g.id).length > 0 && membersOf(g.id).every((p) => p.minimized),
  }));
}

function membersOf(groupId) {
  return people.filter((p) => p.groupId === groupId);
}

export function createGroup(name) {
  const label = String(name ?? '').trim().slice(0, 40) || '새 그룹';
  const group = { id: randomUUID().slice(0, 8), name: label, createdAt: Date.now() };
  state.groups.push(group);
  save();
  announce();
  logActivity('group', `그룹 "${label}" 만듦`);
  return group;
}

export function renameGroup(id, name) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return null;
  group.name = String(name ?? '').trim().slice(0, 40) || group.name;
  save();
  announce();
  return group;
}

export function deleteGroup(id) {
  const before = state.groups.length;
  state.groups = state.groups.filter((g) => g.id !== id);
  if (state.groups.length === before) return false;
  for (const [key, gid] of Object.entries(state.members)) {
    if (gid === id) delete state.members[key];
  }
  for (const [sig, gid] of Object.entries(state.sigs)) {
    if (gid === id) delete state.sigs[sig];
  }
  save();
  refreshDesktop();
  announce();
  return true;
}

/**
 * Move one person into a group (or out of every group with `null`).
 * The signature is written alongside so the same window rejoins after a restart.
 */
export function assign(key, groupId) {
  const person = people.find((p) => p.key === key);
  if (groupId && !state.groups.some((g) => g.id === groupId)) return false;

  if (groupId) {
    state.members[key] = groupId;
    if (person?.sig) state.sigs[person.sig] = groupId;
  } else {
    delete state.members[key];
    if (person?.sig) delete state.sigs[person.sig];
  }
  if (person) person.groupId = groupId ?? null;
  save();
  bus.emit('desktop', desktopState());
  announce();
  return true;
}

/**
 * Stamp each person with the group they belong to, and forget assignments whose
 * window is long gone. Called by desktop.js on every poll.
 */
function decorate(next) {
  const seen = new Set();
  for (const p of next) {
    seen.add(p.key);
    let gid = state.members[p.key];
    if (!gid && p.sig && state.sigs[p.sig]) {
      // Re-adoption: same app, same document, new handle.
      gid = state.sigs[p.sig];
      state.members[p.key] = gid;
    }
    p.groupId = gid && state.groups.some((g) => g.id === gid) ? gid : null;
  }
  // Prune handles that no longer exist. The signature stays, so the window can
  // still come home later.
  let dirty = false;
  for (const key of Object.keys(state.members)) {
    if (seen.has(key)) continue;
    delete state.members[key];
    dirty = true;
  }
  if (dirty) save();

  const changed = next.length !== people.length;
  people = next;
  if (changed) announce();
  return next;
}

bindGroups(decorate);

// ── open / hide ───────────────────────────────────────────────────────────
export async function openGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return { ok: false };
  const members = membersOf(id);
  // A tab's window may hold several of this group's members; restoring it once
  // is enough, and the last one asked for lands in front.
  await showWindows(members.map((p) => p.hwnd));
  logActivity('group', `"${group.name}" 창 ${members.length}개 열기`);
  await refreshDesktop();
  announce();
  return { ok: true, count: members.length };
}

export async function hideGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return { ok: false };
  const members = membersOf(id);
  // Only minimize a window whose every person is in this group. A browser
  // window with one tab from this group and three from another belongs to the
  // other work too, and hiding it would take those with it.
  const byWindow = new Map();
  for (const p of people) {
    const bucket = byWindow.get(p.hwnd) ?? { total: 0, mine: 0 };
    bucket.total += 1;
    if (p.groupId === id) bucket.mine += 1;
    byWindow.set(p.hwnd, bucket);
  }
  const hwnds = [...byWindow.entries()].filter(([, b]) => b.mine > 0 && b.mine === b.total).map(([h]) => h);
  await hideWindows(hwnds);
  logActivity('group', `"${group.name}" 창 ${hwnds.length}개 숨기기`);
  await refreshDesktop();
  announce();
  return { ok: true, count: hwnds.length, skipped: members.length - hwnds.length };
}

export async function toggleGroup(id) {
  const group = listGroups().find((g) => g.id === id);
  if (!group) return { ok: false };
  return group.hidden ? openGroup(id) : hideGroup(id);
}
