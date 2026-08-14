import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config, SESSIONS_DIR } from './config.js';
import { linkInto } from './toolbox.js';

const isWin = process.platform === 'win32';

/**
 * One long-lived `claude` child process per person.
 *
 * Verified in scripts/spike/1-stream-input.mjs: with --input-format stream-json
 * the process stays up across turns and keeps its context, so we write each new
 * instruction to stdin instead of re-spawning with --resume.
 *
 * Two Windows rules, both learned the hard way (see scripts/spike/README.md):
 *
 *  1. Pass paths with FORWARD slashes. A bare `C:\Users\…` argument reaches the
 *     CLI with its backslashes eaten and is then resolved against the cwd, so
 *     `--plugin-dir` and friends silently point at nothing.
 *  2. Never put a multi-line value in argv. We spawn the binary directly, but if
 *     we ever have to fall back through a shell, a newline inside an argument
 *     terminates the command. The system prompt therefore goes to a file and is
 *     passed as `--append-system-prompt-file`.
 */

/** Windows accepts forward slashes everywhere and they survive argv intact. */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Quote one argv element for cmd.exe — only used on the shim fallback path. */
function q(a) {
  const s = String(a);
  if (s === '') return '""';
  return /[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** `claude` spawns children of its own, so kill the tree, not just the parent. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * The child must never be able to reach a billed API path. Claude Code resolves
 * credentials in order, so any of these present would shadow the user's
 * subscription login — strip them all and let it use the login only.
 */
export function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export class Runner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.personId
   * @param {object}  opts.persona      resolved persona (see personas.js)
   * @param {string} [opts.appendSystemPrompt] job instructions etc.
   * @param {string[]} [opts.pluginDirs]
   * @param {object} [opts.mcpServers]  merged into --mcp-config
   * @param {string} [opts.settingsJson] inline --settings payload
   */
  constructor(opts) {
    super();
    this.personId = opts.personId;
    this.persona = opts.persona;
    this.opts = opts;
    this.sessionId = randomUUID();
    this.workdir = path.join(SESSIONS_DIR, this.personId);
    this.child = null;
    this.state = 'starting'; // starting | working | idle | exited
    this.init = null;
    this.stderr = '';
    this.turns = 0;
    this.lastActivityAt = Date.now();
    this.lastText = '';
    this.pendingTools = new Map(); // tool_use_id -> { name, input, at }
    this.recentTools = [];
    this.transcript = []; // { role, kind, text, at }
    this._buf = '';
    this._partial = '';
    this._resuming = false;
    this._restarting = false;
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** The persona prompt plus any job briefing, written where argv can't mangle it. */
  writeSystemPrompt() {
    const body = [this.persona?.systemPrompt, this.opts.appendSystemPrompt]
      .filter(Boolean)
      .join('\n\n');
    if (!body.trim()) return null;
    const dir = path.join(this.workdir, '.crew');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'system.md');
    fs.writeFileSync(file, body, 'utf8');
    return file;
  }

  buildArgs() {
    const p = this.persona ?? {};
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Re-attaching to the same conversation after a restart keeps everything
      // said so far (verified in scripts/spike/README.md), which is what lets
      // "지켜보기" be toggled mid-task instead of only at hire time.
      ...(this._resuming ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
      '--model', p.model || config.defaultModel,
      '--permission-mode', p.permissionMode || 'default',
      '--add-dir', toPosix(this.workdir),
    ];
    if (p.effort) args.push('--effort', p.effort);

    const systemFile = this.writeSystemPrompt();
    if (systemFile) args.push('--append-system-prompt-file', toPosix(systemFile));

    for (const dir of this.opts.pluginDirs ?? []) args.push('--plugin-dir', toPosix(dir));

    if (Array.isArray(p.tools) && p.tools.length) args.push('--tools', p.tools.join(','));

    const allowed = [...(p.allowedTools ?? []), ...(this.opts.alwaysAllowTools ?? [])];
    if (allowed.length) args.push('--allowedTools', ...allowed);
    if (Array.isArray(p.disallowedTools) && p.disallowedTools.length) {
      args.push('--disallowedTools', ...p.disallowedTools);
    }

    const mcpServers = this.opts.mcpServers ?? {};
    if (Object.keys(mcpServers).length) args.push('--mcp-config', JSON.stringify({ mcpServers }));
    // Personas that should not inherit the user's own claude.ai connectors say so.
    if (p.strictMcp !== false) args.push('--strict-mcp-config');

    args.push('--setting-sources', p.settingSources ?? 'user');
    if (this.opts.settingsJson) args.push('--settings', this.opts.settingsJson);

    return args;
  }

  start() {
    fs.mkdirSync(this.workdir, { recursive: true });
    // Give this person the shared document packages before it starts, so making
    // a .pptx or .xlsx doesn't begin with an npm install.
    linkInto(this.workdir);
    this._spawn(this.buildArgs(), { viaShell: false });
    this.emit('change');
    return this;
  }

  _spawn(args, { viaShell }) {
    const bin = config.claudeBin;
    const base = {
      cwd: this.workdir,
      env: childEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    this.child = viaShell
      ? spawn([bin, ...args.map(q)].join(' '), { ...base, shell: true })
      : spawn(bin, args, base);

    this.child.stdout.on('data', (c) => this._onStdout(c));
    this.child.stderr.on('data', (c) => {
      this.stderr = (this.stderr + c.toString('utf8')).slice(-8000);
    });

    this.child.on('error', (err) => {
      // A `claude` installed as an npm .cmd shim cannot be spawned directly on
      // Windows. Retry once through the shell; argv is newline-free by now, so
      // the quoting is safe.
      if (!viaShell && isWin && ['ENOENT', 'EINVAL'].includes(err.code)) {
        this._spawn(args, { viaShell: true });
        return;
      }
      this.state = 'exited';
      this.emit('exit', { code: null, error: err.message });
    });

    this.child.on('close', (code) => {
      // A restart tears the process down on purpose — that is not the person
      // leaving, so don't report it as an exit.
      if (this._restarting) return;
      this.state = 'exited';
      this.emit('exit', { code, error: code === 0 ? null : this.stderr.slice(-500) || null });
    });
  }

  /**
   * Swap the process for a new one attached to the same conversation. Used when
   * the tool set has to change (attaching a visible browser), which the CLI
   * cannot do to a running session.
   */
  async restart({ mcpServers } = {}) {
    if (mcpServers) this.opts.mcpServers = mcpServers;
    const old = this.child;
    this._restarting = true;
    if (old && old.exitCode === null) {
      try { old.stdin.end(); } catch { /* already closed */ }
      await new Promise((resolve) => {
        const done = setTimeout(() => { killTree(old); resolve(); }, 4000);
        old.once('close', () => { clearTimeout(done); resolve(); });
      });
    }
    this._restarting = false;
    this._resuming = true;
    this._buf = '';
    this._partial = '';
    this.state = 'idle';
    this._spawn(this.buildArgs(), { viaShell: false });
    this.emit('change');
    return this;
  }

  _onStdout(chunk) {
    this._buf += chunk.toString('utf8');
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this._onEvent(ev);
    }
  }

  _onEvent(ev) {
    this.lastActivityAt = Date.now();
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.init = ev;
          this.emit('init', ev);
        }
        break;

      case 'stream_event': {
        // Live typing. Only text deltas are worth forwarding to the UI.
        const d = ev.event?.delta;
        if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
          this._partial += d.text;
          this.emit('delta', d.text);
        }
        break;
      }

      case 'assistant': {
        this._partial = '';
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.lastText = block.text;
            this._push({ role: 'assistant', kind: 'text', text: block.text });
            this.emit('assistant', block.text);
          } else if (block.type === 'tool_use') {
            this.pendingTools.set(block.id, { name: block.name, input: block.input, at: Date.now() });
            this.recentTools = [block.name, ...this.recentTools.filter((t) => t !== block.name)].slice(0, 6);
            this._push({ role: 'assistant', kind: 'tool_use', text: block.name, input: block.input });
            this.emit('tool', { phase: 'start', name: block.name, input: block.input, id: block.id });
          }
        }
        break;
      }

      case 'user': {
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const pending = this.pendingTools.get(block.tool_use_id);
          this.pendingTools.delete(block.tool_use_id);
          this._push({ role: 'tool', kind: 'tool_result', text: pending?.name ?? 'tool', isError: !!block.is_error });
          this.emit('tool', { phase: 'end', name: pending?.name, isError: !!block.is_error, id: block.tool_use_id });
        }
        break;
      }

      case 'result': {
        this.state = 'idle';
        this.pendingTools.clear();
        this._partial = '';
        this.emit('result', ev);
        break;
      }

      default:
        break;
    }
    this.emit('change');
  }

  _push(entry) {
    this.transcript.push({ ...entry, at: Date.now() });
    if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
  }

  _write(text) {
    if (!this.alive) return false;
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    return true;
  }

  /**
   * Give this person an instruction. `hidden` messages (kickoffs, job briefings)
   * drive the session but are not shown as something the user typed.
   *
   * Write straight to stdin — do NOT wait for the init event first. In
   * stream-json input mode the CLI emits init only after it has read its first
   * instruction, so gating on init deadlocks the session before it starts.
   */
  send(text, { hidden = false } = {}) {
    const body = String(text ?? '').trim();
    if (!body) return false;
    this.turns += 1;
    this.state = 'working';
    this.lastActivityAt = Date.now();
    if (!hidden) this._push({ role: 'user', kind: 'text', text: body });
    this.emit('change');
    return this._write(body);
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const child = this.child;
    // Give it a moment to exit cleanly, then take the whole tree down.
    setTimeout(() => killTree(child), 1500);
  }

  /** What the UI needs to draw this person. */
  toJSON() {
    const pending = [...this.pendingTools.values()];
    return {
      sessionId: this.sessionId,
      state: this.alive ? this.state : 'exited',
      alive: this.alive,
      model: this.init?.model ?? this.persona?.model ?? null,
      turns: this.turns,
      lastActivityAt: this.lastActivityAt,
      lastText: this.lastText,
      partial: this._partial,
      currentTool: pending[0]?.name ?? null,
      pendingTools: pending.map((t) => t.name),
      recentTools: this.recentTools,
      skills: this.init?.skills ?? [],
      plugins: this.init?.plugins ?? [],
      mcpServers: this.init?.mcp_servers ?? [],
      workdir: this.workdir,
      error: this.state === 'exited' ? this.stderr.slice(-300) || null : null,
    };
  }
}
