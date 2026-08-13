import {
  TILE, px, soft, floorPatch, rug, room, shelf, whiteboard, wallClock, windowPane,
  plant, cooler, printer, chair, desk, emptyDesk, character, bubble, avatarOf, darken,
} from './sprites.js';

/**
 * The office scene.
 *
 * Draw at 1x into a back-buffer, then blit with imageSmoothingEnabled=false so
 * the art scales up with hard pixel edges. Text is *not* drawn on the canvas —
 * nameplates are DOM nodes positioned over it, so they stay crisp at any zoom.
 */

const CELL_W = 96;
const CELL_H = 92;
const COLS = 2;
const WALL_TOP = 46;
const WALL = 4;
const PAD = 14;
const MAX_SCALE = 4;

/** Monitor glow + desk lamp per state. */
const LOOK = {
  starting: { screen: '#1d2733', accent: '#8d8d99', scan: false, lamp: null },
  working: { screen: '#12303a', accent: '#7fd1c0', scan: true, lamp: null },
  idle: { screen: '#1b2430', accent: '#5b8def', scan: false, lamp: null },
  sleeping: { screen: '#171c24', accent: '#3a3f4c', scan: false, lamp: null },
  awaiting_approval: { screen: '#3a1b1b', accent: '#e0705b', scan: false, lamp: '#e0705b' },
  exited: { screen: '#14161a', accent: '#2b303c', scan: false, lamp: null },
  offline: { screen: '#14161a', accent: '#2b303c', scan: false, lamp: null },
};

const RUGS = ['#7a6ea0', '#6a8f7a', '#a08268', '#8a6f8f', '#6f88a0', '#a08a60', '#7f7f8f'];

export class Office {
  constructor(canvas, plateHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plateHost = plateHost;
    this.bb = document.createElement('canvas');
    this.bctx = this.bb.getContext('2d');
    this.state = { crew: [], meta: { maxSeats: 4 } };
    this.scale = 3;
    this.hitboxes = [];
    this.hoverSeat = null;
    this.selectedId = null;
    this.plates = new Map();
    this.pat = { id: null, count: 0, lastDir: 0, until: 0, ruffleUntil: 0 };
    this.onSeatClick = () => {};
    this.onPersonClick = () => {};

    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseleave', () => { this.hoverSeat = null; });
    canvas.addEventListener('click', (e) => this._onClick(e));
  }

  setState(state) {
    this.state = state;
  }

  get seats() {
    return Math.max(1, this.state.meta?.maxSeats ?? 4);
  }

  /** Back-buffer size in 1x pixels: enough room for every seat plus walls. */
  _layout() {
    const rows = Math.ceil(this.seats / COLS);
    const w = WALL * 2 + PAD * 2 + COLS * CELL_W;
    const h = WALL_TOP + PAD + rows * CELL_H + PAD + WALL;
    return { rows, w, h };
  }

  _seatOrigin(seat, layout) {
    const col = seat % COLS;
    const row = Math.floor(seat / COLS);
    return {
      x: WALL + PAD + col * CELL_W,
      y: WALL_TOP + PAD + row * CELL_H,
    };
  }

  /** Floor point a person stands on, and where their desk front edge sits. */
  _seatAnchor(seat, layout) {
    const o = this._seatOrigin(seat, layout);
    return {
      cx: o.x + CELL_W / 2,
      standY: o.y + 46,
      deskY: o.y + 74,
      x: o.x,
      y: o.y,
    };
  }

  _resizeToFit() {
    const { w, h } = this._layout();
    if (this.bb.width !== w || this.bb.height !== h) {
      this.bb.width = w;
      this.bb.height = h;
    }
    // Measure the stage, not the viewport: the viewport shrink-wraps the canvas,
    // so asking it how much room there is would just echo the current size back.
    const host = this.canvas.closest('.stage') ?? this.canvas.parentElement;
    const availW = host.clientWidth;
    const availH = host.clientHeight;
    // Whole-number scale only — a fractional one reintroduces blurry edges.
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.floor(Math.min(availW / w, availH / h))));
    this.scale = scale;
    const cw = w * scale;
    const ch = h * scale;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
  }

  render(now = performance.now()) {
    this._resizeToFit();
    const layout = this._layout();
    const ctx = this.bctx;
    const { w, h } = layout;

    ctx.clearRect(0, 0, w, h);
    floorPatch(ctx, 0, 0, w, h);
    room(ctx, 0, 0, w, h, WALL_TOP, WALL);

    // wall dressing
    shelf(ctx, 12, 12);
    whiteboard(ctx, w - 60, 12);
    wallClock(ctx, Math.round(w / 2), 22, new Date());
    if (w > 220) windowPane(ctx, Math.round(w / 2) - 22, 44 - 24);

    // floor props in the margins
    plant(ctx, 12, h - 12);
    cooler(ctx, w - 14, h - 12);
    if (layout.rows > 1) printer(ctx, w - 16, WALL_TOP + PAD + CELL_H - 6);

    this.hitboxes = [];
    const bySeat = new Map(this.state.crew.map((p) => [p.seat, p]));

    for (let seat = 0; seat < this.seats; seat += 1) {
      const a = this._seatAnchor(seat, layout);
      const person = bySeat.get(seat) ?? null;
      rug(ctx, a.x + 6, a.y + 24, CELL_W - 12, CELL_H - 32, RUGS[seat % RUGS.length]);

      if (!person) {
        chair(ctx, a.cx, a.standY + 4, '#5a5f6e');
        emptyDesk(ctx, a.cx, a.deskY, { hover: this.hoverSeat === seat });
        this.hitboxes.push({ seat, person: null, x: a.x, y: a.y, w: CELL_W, h: CELL_H });
        continue;
      }

      this._drawPerson(ctx, person, a, now);
      this.hitboxes.push({ seat, person, x: a.x, y: a.y, w: CELL_W, h: CELL_H });
    }

    // blit
    const g = this.ctx;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.bb, 0, 0, w, h, 0, 0, w * this.scale, h * this.scale);

    this._syncPlates(layout);
  }

  _drawPerson(ctx, person, a, now) {
    const av = avatarOf(person.seed, person.sprite);
    const look = LOOK[person.state] ?? LOOK.idle;
    const t = now / 1000 + av.phase * 6;
    const working = person.state === 'working';
    const sleeping = person.state === 'sleeping';

    const patted = this.pat.id === person.id && now < this.pat.until;
    const ruffle = this.pat.id === person.id && now < this.pat.ruffleUntil
      ? (this.pat.ruffleUntil - now) / 1600
      : 0;

    chair(ctx, a.cx, a.standY + 4, '#454c5e');

    const bob = sleeping ? 2 : Math.sin(t * (working ? 3.2 : 1.4)) * (working ? 0.8 : 0.5);
    const blink = !sleeping && Math.sin(t * 0.9 + av.phase * 10) > 0.985;
    const headY = character(ctx, a.cx, a.standY, av, {
      bob,
      blink: blink || sleeping,
      typing: working ? t * 7 : 0,
      alpha: person.state === 'exited' ? 0.45 : 1,
      patted,
      ruffle,
    });

    desk(ctx, a.cx, a.deskY, {
      screen: look.screen,
      accent: look.accent,
      scan: look.scan ? (now / 60) % 15 : 0,
      lamp: look.lamp && Math.floor(now / 500) % 2 === 0 ? look.lamp : null,
    });

    // status bubbles beside the head
    if (person.state === 'awaiting_approval') {
      bubble(ctx, a.cx + 16, headY + 2, '!', '#fff1ef', '#c9402c');
    } else if (sleeping) {
      const k = Math.floor(now / 700) % 3;
      ctx.save();
      ctx.globalAlpha = 0.75;
      for (let i = 0; i <= k; i += 1) {
        px(ctx, a.cx + 9 + i * 3, headY - 2 - i * 4, 2, 2, '#5f6879');
      }
      ctx.restore();
    } else if (person.state === 'exited') {
      bubble(ctx, a.cx + 16, headY + 2, '×', '#efeae2', '#6b6257');
    }

    if (person.watch) {
      // a small eye above the monitor: this person shows their browser work
      px(ctx, a.cx + 14, a.deskY - 34, 8, 4, '#f0b45a');
      px(ctx, a.cx + 17, a.deskY - 33, 2, 2, '#2b2b33');
    }

    if (this.selectedId === person.id) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      const box = { x: a.x + 4, y: a.y + 20, w: CELL_W - 8, h: CELL_H - 26 };
      px(ctx, box.x, box.y, box.w, 1, '#f0b45a');
      px(ctx, box.x, box.y + box.h - 1, box.w, 1, '#f0b45a');
      px(ctx, box.x, box.y, 1, box.h, '#f0b45a');
      px(ctx, box.x + box.w - 1, box.y, 1, box.h, '#f0b45a');
      ctx.restore();
    }
  }

  // ── DOM nameplates ────────────────────────────────────────────────────────
  _syncPlates(layout) {
    const seen = new Set();
    for (const person of this.state.crew) {
      seen.add(person.id);
      let plate = this.plates.get(person.id);
      if (!plate) {
        plate = document.createElement('div');
        plate.className = 'plate';
        plate.innerHTML = '<b></b><span class="cap"></span><span class="chips"></span>';
        plate.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onPersonClick(person.id);
        });
        this.plateHost.appendChild(plate);
        this.plates.set(person.id, plate);
      }
      const a = this._seatAnchor(person.seat, layout);
      // Anchor the plate's bottom-centre just above the tallest headpiece
      // (rabbit ears and the wizard hat both reach ~18px over the head).
      const y = (a.standY - 48) * this.scale;
      plate.style.transform = `translate(${a.cx * this.scale}px, ${y}px) translate(-50%, -100%)`;
      plate.dataset.state = person.state;
      plate.classList.toggle('sel', this.selectedId === person.id);

      const name = `${person.name}`;
      if (plate.querySelector('b').textContent !== name) plate.querySelector('b').textContent = name;

      const cap = person.caption || person.personaLabel || '';
      const capEl = plate.querySelector('.cap');
      if (capEl.textContent !== cap) capEl.textContent = cap;
      capEl.classList.toggle('job', !!person.jobName);

      const chips = [];
      const s = person.session;
      if (s?.currentTool) chips.push(`▶ ${s.currentTool}`);
      if (person.watch) chips.push('지켜보는 중');
      if (person.state === 'exited') chips.push('종료됨');
      const chipEl = plate.querySelector('.chips');
      const chipText = chips.join(' · ');
      if (chipEl.textContent !== chipText) chipEl.textContent = chipText;
    }

    for (const [id, el] of this.plates) {
      if (seen.has(id)) continue;
      el.remove();
      this.plates.delete(id);
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────
  _toBuffer(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  _hit(p) {
    return this.hitboxes.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) ?? null;
  }

  _onMove(e) {
    const p = this._toBuffer(e);
    const hit = this._hit(p);
    this.hoverSeat = hit && !hit.person ? hit.seat : null;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';

    // Head-patting easter egg: rub back and forth over someone's head.
    if (!hit?.person) return;
    const dir = Math.sign(e.movementX);
    if (!dir) return;
    const overHead = p.y < hit.y + 52;
    if (!overHead) return;
    if (this.pat.id !== hit.person.id) {
      this.pat = { id: hit.person.id, count: 0, lastDir: dir, until: 0, ruffleUntil: 0 };
      return;
    }
    if (dir !== this.pat.lastDir) {
      this.pat.lastDir = dir;
      this.pat.count += 1;
      if (this.pat.count >= 5) {
        const now = performance.now();
        this.pat.until = now + 1400;
        this.pat.ruffleUntil = now + 1600;
        this.pat.count = 0;
      }
    }
  }

  _onClick(e) {
    const hit = this._hit(this._toBuffer(e));
    if (!hit) return;
    if (hit.person) this.onPersonClick(hit.person.id);
    else this.onSeatClick(hit.seat);
  }
}
