import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(64);

const MAX_LOG = 300;
/** @type {Array<{id:number,ts:number,personId:string|null,kind:string,text:string}>} */
const activity = [];
let logSeq = 0;

/** Append a line to the office ticker and push it to every viewer. */
export function logActivity(kind, text, personId = null, extra = {}) {
  const entry = { id: ++logSeq, ts: Date.now(), personId, kind, text, ...extra };
  activity.push(entry);
  if (activity.length > MAX_LOG) activity.splice(0, activity.length - MAX_LOG);
  bus.emit('activity', entry);
  return entry;
}

export function recentActivity(limit = 60) {
  return activity.slice(-limit);
}
