import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config, SESSIONS_DIR } from './config.js';
import { appendJsonl, readJsonl } from './store.js';
import { equipTools, linkInto } from './toolbox.js';
import { claudeBin } from './tools.js';

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
  // 받아쓰기 스크립트가 어떤 모델을 쓸지. 사람이 고르는 게 아니라 설정에서 온다.
  env.CREW_STT_MODEL = config.sttModel;
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
   * @param {string} [opts.model]        overrides the type's default model
   * @param {string} [opts.effort]       overrides the type's default effort
   * @param {string} [opts.sessionId]    이어 붙일 대화. 없으면 새로 발급한다
   * @param {boolean} [opts.resume]      그 대화에 다시 붙는다 (앱 재시작 후 되살리기)
   */
  constructor(opts) {
    super();
    this.personId = opts.personId;
    this.persona = opts.persona;
    this.opts = opts;
    /**
     * What this one session runs on. It starts from the type's default and can
     * then be changed for this person alone — a heavy job wants opus, a long
     * cheap one wants haiku, and that is a per-person decision rather than a
     * property of what they are.
     */
    this.model = opts.model || opts.persona?.model || config.defaultModel;
    this.effort = opts.effort || opts.persona?.effort || null;
    this.sessionId = opts.sessionId || randomUUID();
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
    /**
     * 나눈 말. 대화 자체는 CLI 가 자기 파일에 적어 두므로 --resume 으로
     * 되살아나지만, **화면에 보여줄 기록**은 우리 것이라 우리가 적어 둬야 한다.
     * 이게 없으면 되살아난 사람은 다 기억하는데 대화창만 텅 비어 있다.
     */
    this.transcript = opts.resume ? readJsonl(this.transcriptFile, 400) : [];
    // 다음 턴부터 새 묶음. 이어 붙인 대화의 마지막 턴에 새 말이 섞이면
    // 화면에서 한 턴처럼 뭉쳐 보인다.
    this.turn = (this.transcript.at(-1)?.turn ?? -1) + 1;
    this._buf = '';
    this._partial = '';
    this.phase = null;   // thinking | writing | tool | null
    this._resuming = !!opts.resume;
    this._restarting = false;
  }

  /** 화면용 대화 기록이 쌓이는 곳. 사람 한 명당 하나. */
  get transcriptFile() {
    return path.join(SESSIONS_DIR, this.personId, '.crew', 'transcript.jsonl');
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * 인사도 못 하고 죽었다 — init 이 한 번도 오지 않았다.
   *
   * 이어 붙이기가 실패하는 모양이 늘 이것이다(붙을 대화가 없으면 CLI 는
   * 곧장 죽는다). 되살리기가 이 신호로 새 대화 전환을 판단하고, 활동 기록은
   * 이걸 보고 "비정상 종료" 라고 겁주지 않는다 — 곧 복구되기 때문이다.
   */
  get stillborn() {
    return this._resuming && !this.init;
  }

  /**
   * Rules every person gets, ahead of its own personality.
   *
   * These exist to overrule Claude Code's defaults, which are written for a
   * developer at a terminal. Left alone a session obeys "always use the
   * scratchpad directory for temporary files" and writes the user's deliverable
   * into a temp path they will never find — observed, not theorised.
   */
  officeRules() {
    return [
      '# 이 사무실의 규칙',
      '',
      '- **결과물은 반드시 작업 폴더(현재 cwd)에 만든다.** 임시 폴더(scratchpad, Temp)에',
      '  만들지 마라. 그 경로는 사용자가 찾을 수 없다. 중간 스크립트도 같은 폴더에 둔다.',
      '- 사용자에게 경로를 알려줄 때는 작업 폴더 기준의 전체 경로를 그대로 적는다.',
      '- 문서용 패키지(`pptxgenjs`, `xlsx`, `exceljs`)는 **작업 폴더에 이미 설치돼 있다.**',
      '  `npm init` 이나 `npm install` 을 하지 마라. 바로 import 해서 쓰면 된다.',
      '- 사용자는 개발자가 아니다. 경로·명령·패키지 이름을 늘어놓지 말고 무엇이 됐는지만 말한다.',
    ].join('\n');
  }

  /** The persona prompt plus any job briefing, written where argv can't mangle it. */
  writeSystemPrompt() {
    const body = [this.officeRules(), this.persona?.systemPrompt, this.opts.appendSystemPrompt]
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
      '--model', this.model,
      '--permission-mode', p.permissionMode || 'default',
      '--add-dir', toPosix(this.workdir),
    ];
    if (this.effort) args.push('--effort', this.effort);

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
    // 이 유형이 쓰는 도구 스크립트 (받아쓰기 등)를 손 닿는 곳에 둔다.
    equipTools(this.workdir, this.persona?.toolbox ?? []);
    this._spawn(this.buildArgs(), { viaShell: false });
    /**
     * 이어 붙인 세션은 뜨는 중이 아니라 **이미 있던 대화로 돌아온 것**이다.
     *
     * stream-json 입력 모드에서 CLI 는 첫 지시를 읽어야만 init 을 내보낸다.
     * 그래서 되살렸는데 아무 말도 안 걸면(끊길 때 일하는 중이 아니었으면)
     * init 이 영영 안 오고 starting 에 갇힌다 — 화면에서는 그게 "일하는 중"
     * 으로 그려져서, 자고 있어야 할 사람이 계속 일하는 척을 한다.
     *
     * 깨우려고 빈 말을 걸 수는 없다. 그건 사람마다 한 턴씩, 업데이트할 때마다
     * 무는 값이다. 그냥 사실대로 적는다 — 이 사람은 지금 쉬고 있다.
     * (restart() 도 같은 이유로 idle 로 둔다.)
     */
    if (this._resuming) this.state = 'idle';
    this.emit('change');
    return this;
  }

  _spawn(args, { viaShell }) {
    // PATH 가 아니라 우리가 찾아 둔 절대 경로로 부른다. 남의 컴퓨터에서는
    // 바탕화면 아이콘으로 켰을 때 PATH 에 claude 가 없어서, 세션이 뜨자마자
    // 죽고 화면에는 "종료됨" 만 남았다.
    const bin = claudeBin();
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
  async restart({ mcpServers, model, effort } = {}) {
    if (mcpServers) this.opts.mcpServers = mcpServers;
    if (model) this.model = model;
    if (effort !== undefined) this.effort = effort;
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

  /**
   * 이어 붙이기가 실패했을 때, 같은 자리에서 새 대화로 다시 시작한다.
   *
   * `--resume` 은 CLI 가 자기 파일에 적어 둔 대화를 찾아 붙는 것이라, 그 파일이
   * 사라졌거나(사용자가 지웠거나 다른 PC 로 옮겼거나) 하면 붙을 데가 없다.
   * 그 경우 CLI 는 init 도 못 내보내고 곧장 죽는다 — 그러니 "한 마디도 못 하고
   * 죽었다" 가 곧 그 신호다. 자리를 비워 두는 것보다 기억만 없는 채로 앉아
   * 있는 편이 낫다. 무엇이 일어났는지는 활동 기록이 말한다.
   */
  startFresh() {
    this.sessionId = randomUUID();
    this._resuming = false;
    this.transcript = [];
    this.turn = 0;
    this.init = null;
    this.stderr = '';
    this._buf = '';
    this._partial = '';
    this.state = 'starting';
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
        const e = ev.event;
        // Which kind of block just opened tells us what the person is doing
        // right now. The thinking block's *text* is always empty — current
        // models never return the raw chain of thought — but its start and stop
        // are real, so "생각 중" is a fact rather than a guess.
        if (e?.type === 'content_block_start') {
          const kind = e.content_block?.type;
          if (kind === 'thinking') this._setPhase('thinking');
          else if (kind === 'text') this._setPhase('writing');
          else if (kind === 'tool_use') this._setPhase('tool');
        }
        const d = e?.delta;
        if (e?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
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
        this._setPhase(null);
        this.turn += 1; // everything pushed from here on belongs to the next turn
        this.emit('result', ev);
        break;
      }

      default:
        break;
    }
    this.emit('change');
  }

  /** thinking | writing | tool | null. Only announced when it actually changes. */
  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }

  /**
   * Stamped with the turn it belongs to. Reloading the page has to rebuild the
   * same conversation the live view showed, and the live view keeps only the
   * last thing a person said in a turn — without this the history cannot tell
   * which remark that was.
   */
  _push(entry) {
    const row = { ...entry, turn: this.turn, at: Date.now() };
    this.transcript.push(row);
    if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    // 도구 하나가 200KB 짜리 파일을 통째로 넘기는 일이 있다. 화면에서 접어 둔
    // 카드 하나 때문에 기록 파일이 그만큼 불어나느니, 그 줄만 인자를 뺀다.
    const line = JSON.stringify(row);
    appendJsonl(this.transcriptFile, line.length > 8000 ? { ...row, input: null, big: true } : row);
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
    this._setPhase('thinking');
    if (!hidden) this._push({ role: 'user', kind: 'text', text: body });
    this.emit('change');
    return this._write(body);
  }

  /**
   * @param {{immediate?: boolean}} [opts] 곧 우리 자신이 죽는 상황이면 true.
   *   평소에는 1.5초를 주고 곱게 나가길 기다리지만, 앱이 재시작으로 곧
   *   강제 종료될 때는 그 타이머가 돌기 전에 우리가 먼저 죽는다 — 그러면
   *   claude 프로세스가 부모 없이 계속 살아남는다(측정으로 확인).
   */
  stop({ immediate = false } = {}) {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const child = this.child;
    if (immediate) { killTree(child); return; }
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
      // What we asked for, and what the CLI says it actually resolved to. The
      // picker has to show the first — `claude-opus-5[1m]` is not an option in
      // any menu — but the second is the one that proves the change took.
      model: this.model,
      effort: this.effort,
      resolvedModel: this.init?.model ?? null,
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
