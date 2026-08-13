import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './config.js';

/**
 * Tiny JSON persistence for the handful of small files the app owns.
 * Writes go through a temp file + rename so a crash mid-write cannot leave a
 * truncated crew.json behind and lose everyone's seats.
 */

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonl(file, limit = Infinity) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const slice = Number.isFinite(limit) ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

export const paths = {
  crew: () => path.join(DATA_DIR, 'crew.json'),
  tasks: () => path.join(DATA_DIR, 'tasks.json'),
  worklog: () => path.join(DATA_DIR, 'worklog.jsonl'),
  config: () => path.join(DATA_DIR, 'config.json'),
};
