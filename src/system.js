import os from 'node:os';
import { config } from './config.js';
import { bus } from './bus.js';

/**
 * Host CPU / memory for the left panel.
 *
 * claude-office also sampled per-session CPU by pid. We deliberately don't:
 * on Windows a person's process is launched through a shell, so `child.pid` is
 * the shell's, and the number would be a confident-looking lie.
 */

let prevCpu = sampleCpu();

let latest = {
  ts: Date.now(),
  cpuPercent: 0,
  cores: os.cpus().length,
  memTotal: os.totalmem(),
  memFree: os.freemem(),
  memPercent: 0,
  uptime: os.uptime(),
  platform: process.platform,
  hostname: os.hostname(),
};

function sampleCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuPercent() {
  const now = sampleCpu();
  const idle = now.idle - prevCpu.idle;
  const total = now.total - prevCpu.total;
  prevCpu = now;
  if (total <= 0) return latest.cpuPercent;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

export function systemStats() {
  return latest;
}

export function startSystemPolling() {
  const tick = () => {
    const memFree = os.freemem();
    const memTotal = os.totalmem();
    latest = {
      ts: Date.now(),
      cpuPercent: cpuPercent(),
      cores: os.cpus().length,
      memTotal,
      memFree,
      memPercent: Math.round(((memTotal - memFree) / memTotal) * 100),
      uptime: os.uptime(),
      platform: process.platform,
      hostname: os.hostname(),
    };
    bus.emit('system', latest);
  };
  tick();
  const t = setInterval(tick, config.systemPollMs);
  t.unref?.();
  return () => clearInterval(t);
}
