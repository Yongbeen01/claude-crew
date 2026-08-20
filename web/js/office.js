import {
  px, floorPatch, rug, room, mushroom, tree,
  plant, chair, desk, emptyDesk, character, bubble, avatarOf,
  door, zoneFloor, partition, orchardFloor, fence, grape, stem, branch,
  busy, zzz,
} from './sprites.js';

/**
 * The office scene.
 *
 * Draw at 1x into a back-buffer, then blit with imageSmoothingEnabled=false so
 * the art scales up with hard pixel edges. Text is *not* drawn on the canvas —
 * nameplates are DOM nodes positioned over it, so they stay crisp at any zoom.
 *
 * The room is laid out for a wide window, and it holds two zones plus a way out.
 *
 *   ┌ 일하는 사람들 ┬ 내가 열어둔 것들 ──────────────┐
 *   │ desk  desk    │   ( o o )     ( o o )        ▓  ← 문
 *   │ desk  desk    │    table       table         ▓
 *   ├───────────────┴─────── 복도 ─────────────────┘
 *
 * Left zone: one Claude session per desk. Right zone: every window and browser
 * tab open on this PC, seated at the table for the piece of work it belongs to.
 * They are different kinds of thing and they never mix, which is why there is a
 * partition between them rather than a gap.
 */

/**
 * 사람과 책상만 방보다 크게. 방(바닥·울타리·포도밭)은 그대로 두고 이 둘만
 * 키우면 화면에서 눈이 가야 할 곳이 커진다.
 */
const SPRITE_SCALE = 1.6;

/**
 * 자리의 치수는 전부 배율에서 나온다.
 *
 * 예전엔 78·96·110·118 이 손으로 맞춰져 있었다. 그래서 배율만 올리면 책상이
 * 옆 책상을 덮고 이름표가 윗줄 책상 위에 앉았다 — 배율과 치수가 따로 놀았기
 * 때문이다. 이제 SPRITE_SCALE 하나만 바꾸면 칸·간격·이름표 높이가 함께 따라온다.
 *
 * 47 = 1× 스프라이트에서 발밑부터 머리 장식(마법사 모자·토끼 귀) 끝까지,
 * 76·22·4 = 책상의 폭, 책상이 사람 뒤로 내려앉는 깊이, 앞면 아래로 남는 껍질.
 */
const CH_TOP = Math.round(47 * SPRITE_SCALE);
const DESK_W = Math.round(76 * SPRITE_SCALE);

/** 한 자리가 차지하는 칸 — 러그와 히트박스의 크기. */
const STAND_Y = CH_TOP + 6; // floor point the person stands on
const DESK_Y = STAND_Y + Math.round(22 * SPRITE_SCALE); // front edge of the desk
const CELL_W = DESK_W + 14;
const CELL_H = DESK_Y + Math.round(4 * SPRITE_SCALE) + 8;
/** Where a workstation sits inside its cell — the rug is sized to this, not to
 *  the cell, or a taller cell stretches it into the next row's nameplate. */
const RUG_TOP = STAND_Y - 24;
const RUG_H = DESK_Y + 6 - RUG_TOP;
/** 이름표가 걸리는 높이. 머리 장식 끝보다 조금 낮다 — 모자챙과 살짝 겹치는
 *  편이, 아무 것도 안 쓴 사람 머리 위에 이름표가 붕 떠 있는 것보다 낫다. */
const PLATE_LIFT = CH_TOP - 14;
/**
 * 책상 배치: 2열 3행.
 *
 * 구역 폭은 책상 덩어리에 사방 여유를 더한 만큼. 행 간격을 열 간격보다 넓게
 * 둔 건 사람 위에 이름표가 걸리기 때문이다 — 가로로 붙는 것보다 세로로 붙는
 * 게 먼저 읽기 힘들어진다.
 */
const CREW_COLS = 2;
const COL_STEP = CELL_W + 8;
const ROW_STEP = CELL_H + 24;
const CREW_ZONE_W = (CREW_COLS - 1) * COL_STEP + CELL_W + 40;

const WALL_TOP = 42;
const WALL = 4;
const PAD = 12;
/**
 * The bottom strip is a corridor, not padding — it is walked along on the way
 * out, and the door opens off it. It has to be taller than the door or the
 * frame runs off the bottom of the room and out through the wall.
 */
const CORRIDOR_H = 52;
const DIVIDER = 10;
const DOOR_BAY = 32;
const DOOR_H = 34;
const MAX_SCALE = 5;

const bigChar = (c, x, y, av, o = {}) => character(c, x, y, av, { ...o, scale: SPRITE_SCALE });
const bigDesk = (c, x, y, o = {}) => desk(c, x, y, { ...o, scale: SPRITE_SCALE });
const bigEmptyDesk = (c, x, y, o = {}) => emptyDesk(c, x, y, { ...o, scale: SPRITE_SCALE });

/**
 * Windows zone geometry.
 *
 * These numbers are chosen for the *shape* of the room, not just to fit the
 * furniture. The view scales by whole numbers only — a fractional one brings
 * back blurry pixels — so a room whose proportions do not match the stage loses
 * a whole zoom step to the floor(). At roughly 470×334 the room is about 1.4:1,
 * which is close enough to a wide stage that the fit lands on the step rather
 * than just under it. Widening the zone by 40px is what costs half the size.
 */
/* 송이 한 자리. 알을 키우면 송이도 그만큼 커지므로 자리도 같이 넓혀야
 * 옆 송이와 알이 겹친다 — 다섯 알짜리 줄이 96px 라 92px 자리로는 넘친다. */
const POD_W = 112;
const POD_H = 124;
const POD_COLS_MAX = 4;
/* 대기 구역의 사람 간격. 이름표가 창 이름을 달고 있어서 30px 로는 라벨이
 * 서로를 덮었다 — 글자가 읽히는 폭까지 벌린다. */
const LOOSE_STEP = 90;
/* 줄 간격. 가로(90)와 비슷하되 조금 좁게 — 이름표가 윗줄 사람 발치에 닿지
 * 않을 만큼만. */
const LOOSE_ROW_H = 72;
/**
 * The floor under the windows zone, not its usual size — it grows into whatever
 * the stage has spare. Keeping the floor low is what lets the whole room land
 * on a 2× or 3× zoom instead of 1×: the minimum room is what the whole-number
 * fit is computed from, and 40px of unused minimum width costs a zoom step.
 */
const WIN_MIN_W = 120;
const ZONE_MIN_H = 196;

/* 창 구역을 위(그룹)/아래(아직 안 묶은 것)로 가르는 고정 비율과 그 사이 틈. */
const GROUP_BAND = 0.56;
const BAND_GAP = 12;

/* 포도알 반지름. 대기 구역의 가로 간격은 알 크기와 무관하게 그대로 둔다 —
 * 그 간격을 정한 건 이름표가 읽히는 폭이기 때문이다.
 * 송이의 치수(줄 간격·가지 길이·이름표 높이)는 전부 이 값에서 나오므로,
 * 여기만 키우면 송이도 같은 비율로 커진다. */
const GRAPE_R = 10;

/**
 * Monitor glow + desk lamp per state.
 *
 * idle 의 수정이 예전엔 파랗게 밝았다. 그런데 idle 은 "쉬는 중" 이 아니라
 * **세션이 멈춰 있다** 는 뜻이라(대답을 마쳤거나 도구가 끊겼거나), 그 자리에서
 * 사람은 잠들어 있는데 수정만 환한 건 서로 다른 말을 하는 것이었다. 잠든
 * 사람 옆의 수정은 잦아든다.
 */
const LOOK = {
  starting: { screen: '#1d2733', accent: '#8d8d99', scan: true, lamp: null },
  working: { screen: '#12303a', accent: '#7fd1c0', scan: true, lamp: null },
  idle: { screen: '#1b2430', accent: '#46577a', scan: false, lamp: null },
  sleeping: { screen: '#171c24', accent: '#3a3f4c', scan: false, lamp: null },
  awaiting_approval: { screen: '#3a1b1b', accent: '#e0705b', scan: false, lamp: '#e0705b' },
  leaving: { screen: '#14161a', accent: '#2b303c', scan: false, lamp: null },
  exited: { screen: '#14161a', accent: '#2b303c', scan: false, lamp: null },
  offline: { screen: '#14161a', accent: '#2b303c', scan: false, lamp: null },
};

const RUGS = ['#7a6ea0', '#6a8f7a', '#a08268', '#8a6f8f', '#6f88a0', '#a08a60', '#7f7f8f'];

/**
 * Leaving, in milliseconds from the moment the office first sees it.
 * The clock is the client's, not the server's: the walk has to line up with
 * what is on screen, and the two machines' idea of "now" is the same machine
 * here but need not stay that way.
 */
const CRY_MS = 2400;
const PACK_MS = 2600;
const WALK_MS = 3600;
const FADE_MS = 600;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * One colour per program, the same everywhere it appears.
 *
 * The point is telling programs apart at a glance in a room holding twenty
 * windows: every Chrome window carries the same chip, and it is not the chip
 * Excel carries. Twelve hues rather than seven because seven collide fast once
 * a real desktop is on screen.
 */
const APP_HUES = [
  '#5b8def', '#5fd39a', '#f0b45a', '#e0705b', '#a77bd8', '#4ec3d9',
  '#e88fc0', '#8ab44a', '#d9954e', '#6f7fd0', '#4aa88a', '#c86a8f',
];
/**
 * Hashing the name was the obvious way and it was wrong: with seven programs
 open it handed Chrome and 터미널 the same pink, which is exactly the question
 * the colour exists to answer. So the colours are *assigned* instead — the
 * programs on screen are sorted and dealt one hue each, which collides only
 * past twelve and is stable as long as the same set is open.
 */
function assignHues(apps) {
  const map = new Map();
  [...new Set(apps.filter(Boolean))].sort().forEach((name, i) => {
    map.set(name, APP_HUES[i % APP_HUES.length]);
  });
  return map;
}

/** Dark ink on a light chip, light ink on a dark one. */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#2a1a0e' : '#fffaec';
}

export class Office {
  constructor(canvas, plateHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plateHost = plateHost;
    this.bb = document.createElement('canvas');
    this.bctx = this.bb.getContext('2d');
    this.state = { crew: [], meta: { maxSeats: 4 }, desktop: { people: [] }, groups: [] };
    this.scale = 3;
    this.hitboxes = [];
    this.hoverSeat = null;
    /** Seat under a held-down pointer. Feedback belongs on the press, not the
     *  release, so this is drawn immediately and the click still commits. */
    this.pressSeat = null;
    this.selectedId = null;
    this.plates = new Map();
    this.winPlates = new Map();
    this.groupPlates = new Map();
    // Two standing signs, so it is never a guess which half of the room is
    // which. Created once — they are the only fixtures in the overlay.
    this.zoneLabels = ['일하는 사람들', '묶어둔 그룹', '아직 안 묶은 창들'].map((text) => {
      const node = document.createElement('div');
      node.className = 'zlabel';
      node.textContent = text;
      plateHost.appendChild(node);
      return node;
    });
    this.pat = { id: null, count: 0, lastDir: 0, until: 0, ruffleUntil: 0 };
    /** personId -> performance.now() when this office first saw them leaving */
    this.leaveClock = new Map();
    /** in-flight pointer gesture, see _onDown */
    this.press = null;
    this.drag = null;
    this.geom = null;
    /** a card dragged in from a side panel is not our gesture, but the room
     *  still has to light up for it — main.js sets the group id it is over */
    this.dropHint = null;

    this.onSeatClick = () => {};
    this.onPersonClick = () => {};
    this.onDropAtDoor = () => {};
    this.onWindowClick = () => {};
    this.onWindowDrop = () => {};
    this.onGroupToggle = () => {};
    this.onGroupRename = () => {};
    /** tapping the table itself — the group opens up rather than being renamed */
    this.onGroupClick = () => {};

    /** 알 위에 머물렀을 때 옆에 띄우는 카드 — 아래 _syncGrapeCard */
    this.grapeCard = null;

    canvas.addEventListener('mousemove', (e) => this._onHover(e));
    canvas.addEventListener('mouseleave', () => {
      this.hoverSeat = null;
      this._syncGrapeCard(null);
    });
    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    for (const ev of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(ev, (e) => this._onUp(e));
    }
  }

  setState(state) {
    this.state = state;
  }

  get seats() {
    return Math.max(1, this.state.meta?.maxSeats ?? 4);
  }

  /** 이번 프레임의 앱→색. render() 가 채운다. */
  _hueFor(app) {
    return this.appHue?.get(app) ?? APP_HUES[0];
  }

  get windowPeople() {
    return this.state.desktop?.people ?? [];
  }

  get groups() {
    return this.state.groups ?? [];
  }

  // ── layout ────────────────────────────────────────────────────────────────
  /**
   * Everything is computed from the two populations, once per frame. Cheap
   * enough at 24fps, and it means a window opening on the far side of the PC
   * reflows the room without any invalidation bookkeeping.
   *
   * The room *grows into* the stage rather than shrinking to fit it. Zoom is
   * whole-number only, so a fixed-size room spends most of its life just under
   * a step — 470px wide in a 930px stage renders at 1×, and half the screen is
   * wasted on a picture at half the size it could be. So: pick the largest
   * whole zoom the minimum room fits at, then hand the leftover pixels to the
   * windows zone and the corridor. The room is always exactly the stage.
   */
  _layout() {
    const host = this.canvas.closest('.stage') ?? this.canvas.parentElement;
    const availW = Math.max(160, host.clientWidth);
    const availH = Math.max(160, host.clientHeight);

    const crewRows = Math.ceil(this.seats / CREW_COLS);
    const aiW = CREW_ZONE_W;
    const aiH = (crewRows - 1) * ROW_STEP + CELL_H;

    // Off Windows there is no way to enumerate what is open, so there is no
    // second zone — the room is just the desks and the door rather than a large
    // empty area labelled with something this machine cannot show.
    const showWin = this.state.desktop?.supported !== false;
    const chromeW = WALL + PAD + aiW + (showWin ? DIVIDER : 0) + DOOR_BAY + WALL;
    const chromeH = WALL_TOP + PAD + CORRIDOR_H + WALL;

    const people = this.windowPeople;
    const byGroup = new Map();
    for (const g of this.groups) byGroup.set(g.id, []);
    const loose = [];
    for (const p of people) {
      if (p.groupId && byGroup.has(p.groupId)) byGroup.get(p.groupId).push(p);
      else loose.push(p);
    }
    const podCount = byGroup.size;

    // How much room the contents want, before the stage has a say.
    //
    // Zooming further in is not automatically better: at 3× this room would be
    // 414px across and the windows zone one table wide, while 2× fits three. So
    // the zoom is chosen from what has to fit — and how much has to fit depends
    // on how the tables are arranged, which is why every column count gets
    // costed and the one that buys the biggest zoom wins. Four tables in a row
    // is a short wide room; four in a column is a tall narrow one, and only one
    // of those matches the screen.
    let best = null;
    for (let cols = 1; cols <= POD_COLS_MAX; cols += 1) {
      const winWant = showWin ? Math.max(WIN_MIN_W, cols * POD_W) : 0;
      const lCols = Math.max(4, Math.floor((winWant - 24) / LOOSE_STEP));
      const ww = chromeW + winWant;
      // 위 띠(테이블)만 방 높이를 요구한다. 대기 인원까지 여기에 넣으면,
      // 창이 15개만 열려 있어도 방이 무대보다 커져서 통째로 축소돼 버렸다 —
      // 대기 인원은 방을 키울 게 아니라 띠 안에서 줄을 접으면 되는 것이다.
      const wantPod = Math.ceil(podCount / cols) * POD_H;

      const hh = chromeH + Math.max(
        aiH, ZONE_MIN_H,
        Math.round(wantPod / GROUP_BAND) + BAND_GAP,
      );
      // Whole-number zoom keeps the pixels hard, and that is what we want
      // whenever the room fits. But a short window could not be served by any
      // whole number ≥ 1 — the smallest room simply did not fit, and the bottom
      // of it was cut off by the stage. Below 1× we take the exact ratio
      // instead: a slightly soft room beats a room with its floor missing.
      const raw = Math.min(availW / ww, availH / hh);
      const s = raw >= 1 ? Math.min(MAX_SCALE, Math.floor(raw)) : raw;
      if (!best || s > best.s) best = { s, ww, hh };
      if (cols >= podCount) break;
    }

    const scale = best.s;
    this.scale = scale;
    const w = Math.max(best.ww, Math.floor(availW / scale));
    const h = Math.max(best.hh, Math.floor(availH / scale));
    const winW = w - chromeW;
    const zoneH = h - chromeH;

    const podCols = Math.max(1, Math.min(POD_COLS_MAX, Math.floor(winW / POD_W), podCount || 1));
    const podRows = Math.ceil(podCount / podCols);
    // 줄 수는 띠 높이가, 열 수는 띠 너비가 정한다 — 둘 다 지켜야 한다.
    //
    // 세로에 담으려고 열만 늘리면 그 열들이 가로를 넘어가서, 사람들이 방
    // 바깥에 줄지어 서 있었다 (대화창을 넓히면 오른쪽 몇 명이 사라졌다).
    // 열이 더 필요하면 늘리되, 간격을 좁혀 폭 안에 다시 밀어 넣는다.
    const looseBandH0 = zoneH - Math.max(88, Math.round(zoneH * GROUP_BAND)) - BAND_GAP;
    const rowsFit = Math.max(1, Math.floor((looseBandH0 - 8) / LOOSE_ROW_H));
    const usableW = Math.max(60, winW - 28);
    let looseCols = Math.max(1, Math.floor(usableW / LOOSE_STEP));
    let looseStep = LOOSE_STEP;
    if (loose.length) {
      const need = Math.ceil(loose.length / rowsFit);
      if (need > looseCols) {
        looseCols = need;
        looseStep = Math.max(18, Math.floor(usableW / looseCols));
      }
    }
    const looseRows = Math.ceil(loose.length / looseCols);

    const x0 = WALL + PAD;
    const y0 = WALL_TOP + PAD;
    const corridorY = y0 + zoneH + Math.round(CORRIDOR_H * 0.5);

    // Crew desks, spread down whatever height the zone ended up with — a room
    // that grew taller should give the desks more floor, not leave a strip of
    // bare wood under them.
    const cellStepY = ROW_STEP;
    // 책상 덩어리를 구역 한가운데에. 남는 바닥은 사방으로 고르게 남는다.
    const blockW = (CREW_COLS - 1) * COL_STEP + CELL_W;
    const blockH = (crewRows - 1) * cellStepY + CELL_H;
    const aiX0 = x0 + Math.round((aiW - blockW) / 2);
    const aiY0 = y0 + Math.max(0, Math.round((zoneH - blockH) / 2));
    const cells = [];
    for (let seat = 0; seat < this.seats; seat += 1) {
      const col = seat % CREW_COLS;
      const row = Math.floor(seat / CREW_COLS);
      const x = aiX0 + col * COL_STEP;
      const y = Math.round(aiY0 + row * cellStepY);
      cells.push({ seat, x, y, cx: x + CELL_W / 2, standY: y + STAND_Y, deskY: y + DESK_Y });
    }

    // The windows half is itself cut in two, and the cut does NOT move with how
    // much is in each half.
    //
    // A band you can only drop into once something is already in it is not a
    // target — you could never make the first group. So the tables get a fixed
    // share of the height whether or not any tables exist, and the waiting area
    // keeps the rest whether or not anyone is waiting in it.
    const winX = x0 + aiW + DIVIDER;
    const podBand = Math.max(88, Math.round(zoneH * GROUP_BAND));
    const looseTop = y0 + podBand + BAND_GAP;
    const looseH = y0 + zoneH - looseTop;
    const podStepX = winW / podCols;
    // Normally a table gets its full height and any surplus on top. The floor
    // is there for the case the surplus is negative — a zone squeezed by a lot
    // of loose windows must still keep its tables inside itself.
    const podStepY = podRows
      ? Math.max(76, Math.min(POD_H, podBand / podRows), podBand / podRows)
      : POD_H;

    const pods = [];
    let i = 0;
    for (const g of this.groups) {
      const members = byGroup.get(g.id) ?? [];
      const cx = winX + (i % podCols) * podStepX + podStepX / 2;
      // Centred in its share of the band, so a single row of tables sits in the
      // middle of the zone rather than clinging to the top of it.
      const cy = y0 + Math.floor(i / podCols) * podStepY + podStepY / 2 - 6;
      pods.push({ group: g, members, cx, cy, ...this._bunch(members, cx, cy) });
      i += 1;
    }

    // 아래 띠 안에서 세로 가운데로. 띠 높이는 내용과 무관하게 고정이라,
    // 맨 위에 붙여 두면 사람 몇 명이 천장에 매달린 것처럼 보이고 나머지
    // 공간이 통째로 빈다.
    const looseBandH = y0 + zoneH - looseTop;
    const looseBlockH = looseRows * LOOSE_ROW_H;
    const looseY0 = looseTop + Math.max(6, Math.round((looseBandH - looseBlockH) / 2));
    const seatsLoose = loose.map((p, n) => ({
      person: p,
      x: winX + 14 + (n % looseCols) * looseStep,
      y: looseY0 + Math.floor(n / looseCols) * LOOSE_ROW_H + 24,
    }));

    return {
      w, h, x0, y0, zoneH, corridorY, showWin,
      ai: { x: x0, y: y0, w: aiW, h: zoneH, cells },
      win: {
        x: winX, y: y0, w: winW, h: zoneH, pods, loose: seatsLoose,
        looseTop, looseH, hasLoose: seatsLoose.length > 0,
      },
      divider: { x: x0 + aiW + Math.round((DIVIDER - 4) / 2), y: y0 - 6, h: zoneH + 6 },
      door: { x: w - WALL, y: corridorY - DOOR_H / 2, h: DOOR_H, cx: w - WALL - 6, cy: corridorY },
    };
  }

  /**
   * Where the members of one group sit. A flattened circle, because the room is
   * seen from above at an angle; more than eight and a second ring forms inside
   * rather than the outer one turning into a solid wall of shoulders.
   */
  /**
   * 한 그룹의 알들이 어디에 달리는가 — 가지에 매달린 포도송이.
   *
   * 맨 윗줄은 **가지에 직접** 달린다. 그 줄이 차면 가지는 알 뒤로 가려지고,
   * 그 다음부터는 아래로 줄을 더해 가며 송이가 굵어진다. 그래서 알이 몇 개
   * 없을 때는 가지가 보이고, 많아지면 가지 없이 알 덩어리만 보인다.
   *
   * 아래로 갈수록 한 줄에 들어가는 알이 하나씩 줄어든다 — 그게 송이가 아래로
   * 좁아지는 모양을 만든다. 줄은 반 칸씩 어긋나게 놓아 알 사이가 메워진다.
   */
  _bunch(members, cx, cy) {
    const k = members.length;
    // 진짜 송이는 알이 서로 닿아 있다. 반지름의 두 배보다 좁게 두면 알이 겹쳐
    // 붙고, 줄을 반 칸 어긋내면 아랫줄 알이 윗줄 두 알 사이에 끼어 앉는다 —
    // 사진 속 포도가 그렇게 쌓여 있다.
    const STEP = GRAPE_R * 2 - 1;
    const ROW = GRAPE_R * 2 - 5;
    const wide = Math.max(2, Math.min(5, Math.round(Math.sqrt(k) + 0.8)));

    /**
     * 줄 폭은 **아래에서부터** 쌓는다. 맨 아래가 한 알, 위로 갈수록 한 알씩
     * 넓어지다 상한에서 멈춘다. 그래야 끝이 뾰족한 송이가 된다.
     *
     * 위에서부터 채웠더니 남는 알이 맨 아랫줄에 몰려 아래가 뭉툭한 벽돌이
     * 됐다 — 열네 알이 5·5·4 로 서서 직사각형이었다.
     *
     * 알이 모자라 맨 윗줄이 아랫줄보다 좁아지는 건 그대로 둔다. 사진 속
     * 송이도 꼭지 쪽은 좁다가 가운데서 벌어진다.
     */
    const rows = [];
    if (k <= 2) {
      // 두 알까지는 나란히 가지에 매단다. 세로로 세우면 알 하나에 알 하나가
      // 매달린 꼴이라 송이가 아니라 사고처럼 보인다.
      rows.push(k);
    } else {
      let left = k;
      for (let n = 1; left > 0; n = Math.min(wide, n + 1)) {
        const take = Math.min(n, left);
        rows.push(take);
        left -= take;
      }
      rows.reverse();
    }

    const widest = Math.max(...rows);
    const branchW = Math.max(26, (widest - 1) * STEP + 16);
    const bunchH = rows.length * ROW;
    // 가지는 송이 맨 위, 송이 전체는 자리의 한가운데에 오도록
    const branchY = Math.round(cy - bunchH / 2 - 8);

    const seats = [];
    let i = 0;
    rows.forEach((n, r) => {
      // 줄이 좁아지면서 생기는 어긋남이 곧 알이 끼어 앉는 자리가 된다
      const rowW = (n - 1) * STEP;
      const x0 = cx - rowW / 2;
      for (let c = 0; c < n; c += 1) {
        seats.push({
          person: members[i],
          // 가지(3px) + 꼭지 + 알 반지름만큼 내려야 가지가 알 위로 보인다.
          // 10 으로 뒀더니 첫 줄이 가지를 통째로 덮어 버렸다.
          x: Math.round(x0 + c * STEP),
          y: Math.round(branchY + GRAPE_R + 8 + r * ROW),
          row: r,
          // 첫 줄만 가지에 직접 매달린다
          hangs: r === 0,
        });
        i += 1;
      }
    });

    // 뒤에서 앞으로 — 아래 줄이 위 줄을 덮어야 송이로 보인다
    seats.sort((a, b) => a.y - b.y);
    // 이름표는 두 줄로 번갈아 건다. 한 송이에 여섯 개가 한 줄로 서면 전부
    // 말줄임이 되어 아무것도 못 읽는다.
    seats.forEach((s, n) => { s.lane = n % 2; });
    return {
      seats,
      r: Math.max(22, branchW / 2),
      branch: { x: Math.round(cx - branchW / 2), y: branchY, w: branchW },
    };
  }

  /** The zoom is decided in _layout(); this only sizes the buffers to match. */
  _resizeToFit(w, h) {
    if (this.bb.width !== w || this.bb.height !== h) {
      this.bb.width = w;
      this.bb.height = h;
    }
    const scale = this.scale;
    const cw = w * scale;
    const ch = h * scale;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
  }

  // ── render ────────────────────────────────────────────────────────────────
  render(now = performance.now()) {
    const g = this._layout();
    this.geom = g;
    // 이번 프레임에 화면에 있는 프로그램들에게 색을 나눠준다.
    this.appHue = assignHues(this.windowPeople.map((p) => p.app));
    this._resizeToFit(g.w, g.h);
    const ctx = this.bctx;
    const { w, h } = g;

    ctx.clearRect(0, 0, w, h);
    floorPatch(ctx, 0, 0, w, h);
    room(ctx, 0, 0, w, h, WALL_TOP, WALL);

    // 숲에 걸린 것들 — 팻말이 걸리는 자리는 비워 둔다.
    mushroom(ctx, 16, WALL_TOP - 2);
    mushroom(ctx, g.x0 + 52, WALL_TOP - 4, '#c9a7ff');
    if (w > 420) mushroom(ctx, w - 68, WALL_TOP - 3, '#ffd88f');

    // 왼쪽은 숲의 빈터(사람들이 일하는 곳), 오른쪽 두 띠는 포도밭이다.
    zoneFloor(ctx, g.ai.x - 6, g.ai.y - 6, g.ai.w + 12, g.zoneH + 10, '#f0b45a');
    if (g.showWin) {
      const bandH = (g.win.looseTop - BAND_GAP / 2) - (g.win.y - 6);
      orchardFloor(ctx, g.win.x - 6, g.win.y - 6, g.win.w + 12, bandH, '#7fd1c0');
      orchardFloor(ctx, g.win.x - 6, g.win.looseTop - BAND_GAP / 2, g.win.w + 12,
        (g.win.y + g.zoneH + 4) - (g.win.looseTop - BAND_GAP / 2), '#a77bd8');
      partition(ctx, g.divider.x, g.divider.y, g.divider.h);
      this._dressWindows(ctx, g);
    }

    // 아래쪽 빈 띠에도 나무를 세운다. 사람도 알도 이 아래로는 오지 않으므로
    // 여기서는 나무가 내용을 가리지 않는다 — 가릴 자리에는 두지 않았다.
    const treeLine = h - 4;
    const jitter = (v) => ((Math.imul(v, 2654435761) >>> 8) % 1000) / 1000;
    // 뒷줄 먼저, 그 앞을 큰 나무가 덮는다
    for (let tx = 6; tx < w; tx += 22 + Math.round(jitter(tx + 91) * 16)) {
      if (tx < g.door.x - 42) tree(ctx, tx, treeLine - 8, 8 + Math.round(jitter(tx + 91) * 5), tx * 3);
    }
    for (let tx = 14; tx < w; tx += 26 + Math.round(jitter(tx) * 26)) {
      // 문 앞은 비워 둔다 — 나가는 길을 나무로 막지 않는다
      const n = jitter(tx);
      if (tx < g.door.x - 42) tree(ctx, tx, treeLine + Math.round(n * 4), 12 + Math.round(n * 9), tx * 5);
    }

    // 숲 바닥에 놓인 것들
    plant(ctx, 14, h - 8);
    mushroom(ctx, g.win.x - 18, h - 8);
    if (g.ai.cells.length > 2) plant(ctx, g.ai.x + g.ai.w - 10, h - 10);

    this.hitboxes = [];

    this._drawCrew(ctx, g, now);
    if (g.showWin) this._drawWindows(ctx, g, now);

    const doorHot = this.drag?.kind === 'crew' && this.drag.over === 'door';
    door(ctx, g.door.x, g.door.y, g.door.h, WALL, { hover: doorHot });
    this.hitboxes.push({
      kind: 'door', x: g.door.x - 20, y: g.door.y - 10, w: 30, h: g.door.h + 20,
    });

    // Whoever is in the air, drawn last so they are over everything.
    if (this.drag?.moved) this._drawDragged(ctx, now);

    // blit
    const out = this.ctx;
    out.imageSmoothingEnabled = false;
    out.clearRect(0, 0, this.canvas.width, this.canvas.height);
    out.drawImage(this.bb, 0, 0, w, h, 0, 0, w * this.scale, h * this.scale);

    this._syncPlates(g);
    this._syncWinPlates(g.showWin ? g : { win: { pods: [], loose: [] } });
    this._syncGroupPlates(g.showWin ? g : { win: { pods: [] } });
    // With one zone there is nothing to tell apart, so the signs come down.
    const signY = (WALL_TOP - 8) * this.scale;
    this.zoneLabels[0].hidden = !g.showWin;
    this.zoneLabels[0].style.transform =
      `translate(${(g.ai.x + g.ai.w / 2) * this.scale}px, ${signY}px) translate(-50%, -100%)`;
    // The two window bands are stacked, so their signs cannot both hang on the
    // back wall — the upper one does, and the lower one sits on the line that
    // divides them, which is also the thing it is naming.
    this.zoneLabels[1].hidden = !g.showWin;
    this.zoneLabels[1].style.transform =
      `translate(${(g.win.x + g.win.w / 2) * this.scale}px, ${signY}px) translate(-50%, -100%)`;
    // Hung just *inside* the lower band rather than above its line: over the
    // line it lands among whatever is sitting at the foot of the group band.
    this.zoneLabels[2].hidden = !g.showWin;
    this.zoneLabels[2].style.transform =
      `translate(${(g.win.x + g.win.w / 2) * this.scale}px, ${(g.win.looseTop + 2) * this.scale}px) translate(-50%, 0)`;
  }

  _drawCrew(ctx, g, now) {
    const bySeat = new Map(this.state.crew.map((p) => [p.seat, p]));
    for (const a of g.ai.cells) {
      const person = bySeat.get(a.seat) ?? null;
      rug(ctx, a.x + 6, a.y + RUG_TOP, CELL_W - 12, RUG_H, RUGS[a.seat % RUGS.length]);

      if (!person) {
        chair(ctx, a.cx, a.standY + 4, '#5a5f6e');
        bigEmptyDesk(ctx, a.cx, a.deskY, { hover: this.hoverSeat === a.seat });
        this.hitboxes.push({ kind: 'seat', seat: a.seat, person: null, x: a.x, y: a.y, w: CELL_W, h: CELL_H });
        continue;
      }

      const leaving = this._leaveProgress(person, now);
      // Once they are on their feet the desk is empty; the walk is drawn on top
      // of the whole room, not clipped to this cell.
      this._drawPerson(ctx, person, a, now, leaving);
      this.hitboxes.push({ kind: 'seat', seat: a.seat, person, x: a.x, y: a.y, w: CELL_W, h: CELL_H });
    }
    // Anyone mid-walk crosses zones, so they go after every desk is down.
    for (const person of this.state.crew) {
      const leaving = this._leaveProgress(person, now);
      if (leaving?.phase === 'walk' || leaving?.phase === 'gone') {
        this._drawWalkOut(ctx, g, person, leaving, now);
      }
    }

    // Press highlight, drawn over whoever is in the seat.
    if (this.pressSeat !== null && !this.drag?.moved) {
      const a = g.ai.cells.find((c) => c.seat === this.pressSeat);
      if (a) px(ctx, a.x + 6, a.y + RUG_TOP, CELL_W - 12, RUG_H, '#ffffff14');
    }
  }

  /** null unless this person is on their way out; otherwise where in it they are. */
  _leaveProgress(person, now) {
    if (person.state !== 'leaving') {
      this.leaveClock.delete(person.id);
      return null;
    }
    let t0 = this.leaveClock.get(person.id);
    if (t0 === undefined) {
      t0 = now;
      this.leaveClock.set(person.id, t0);
    }
    const t = now - t0;
    if (t < CRY_MS) return { phase: 'cry', t, k: t / CRY_MS };
    if (t < CRY_MS + PACK_MS) return { phase: 'pack', t, k: (t - CRY_MS) / PACK_MS };
    if (t < CRY_MS + PACK_MS + WALK_MS) return { phase: 'walk', t, k: (t - CRY_MS - PACK_MS) / WALK_MS };
    return { phase: 'gone', t, k: Math.min(1, (t - CRY_MS - PACK_MS - WALK_MS) / FADE_MS) };
  }

  _drawPerson(ctx, person, a, now, leaving) {
    const av = avatarOf(person.seed, person.sprite);
    const look = LOOK[person.state] ?? LOOK.idle;
    const t = now / 1000 + av.phase * 6;
    /**
     * 방에서 사람은 두 모습 중 하나다: 일하고 있거나, 자고 있거나.
     *
     * working 은 지시를 받은 순간부터 그 턴이 끝날 때까지다 — 도구를 돌리는
     * 동안도 여기에 들어간다. 그 턴이 어떻게든 끝나면(대답을 마쳤든, 도구가
     * 중간에 끊겼든) 세션은 idle 이 되고, 그때부터는 잔다. 예전엔 idle 인
     * 사람이 눈 뜨고 앉아 있어서, 멈춘 세션과 돌아가는 세션이 화면에서
     * 똑같아 보였다 — 방을 훑어 무엇이 돌고 있는지 아는 게 이 화면의 일인데.
     *
     * sleeping(5분 넘게 조용함)은 같은 잠이되 더 깊다: 더 처지고 더 느리다.
     */
    const working = person.state === 'working' || person.state === 'starting';
    const sleeping = person.state === 'sleeping';
    const asleep = sleeping || person.state === 'idle';
    const deep = sleeping;
    const dragging = this.drag?.moved && this.drag.kind === 'crew' && this.drag.id === person.id;

    const patted = this.pat.id === person.id && now < this.pat.until;
    const ruffle = this.pat.id === person.id && now < this.pat.ruffleUntil
      ? (this.pat.ruffleUntil - now) / 1600
      : 0;

    chair(ctx, a.cx, a.standY + 4, '#454c5e');

    // Off walking, or held in the air — either way not at this desk any more.
    const atDesk = !leaving || leaving.phase === 'cry' || leaving.phase === 'pack';
    if (atDesk && !dragging) {
      const crying = !!leaving;
      const dozing = asleep && !crying;
      // 숨. 자는 사람은 느리게, 일하는 사람은 빠르게 — 같은 위아래 움직임이라도
      // 리듬이 다르면 멀리서도 다른 상태로 읽힌다.
      const breath = t * (deep ? 0.7 : 1.05);
      // Sobbing is a shake, not a bob — a different rhythm from breathing.
      const bob = crying
        ? Math.sin(t * 9) * 0.9
        : dozing
          ? 1 + Math.sin(breath) * 0.7
          : Math.sin(t * (working ? 3.4 : 1.4)) * (working ? 0.9 : 0.5);
      const blink = !dozing && Math.sin(t * 0.9 + av.phase * 10) > 0.985;
      const headY = bigChar(ctx, a.cx, a.standY, av, {
        bob,
        blink,
        asleep: dozing,
        breath,
        // 자면 고개가 한쪽으로 기운 채 굳고, 일하면 화면을 훑느라 좌우로 흔들린다
        tilt: dozing ? 1 : working && !crying ? Math.round(Math.sin(t * 1.7)) : 0,
        typing: working && !crying ? t * 7 : 0,
        alpha: person.state === 'exited' ? 0.45 : 1,
        patted: patted && !crying,
        ruffle,
        crying,
        droop: crying ? 1 : dozing ? (deep ? 1 : 0.5) : 0,
        step: crying ? t * 9 : 0,
      });

      // The box fills up on the desk while they pack, before it is picked up.
      if (leaving?.phase === 'pack') {
        this._packBox(ctx, a.cx - 24, a.deskY - 32, leaving.k);
      }

      if (person.state === 'awaiting_approval') {
        bubble(ctx, a.cx + 16, headY + 2, '!', '#fff1ef', '#c9402c');
      } else if (dozing) {
        // 머리 옆에서 떠올라 사라지는 Z. 예전엔 회색 점 세 개가 켜졌다 꺼지길
        // 반복했는데, 점은 로딩 표시로도 읽혀서 "자는 중" 이 되지 못했다.
        zzz(ctx, a.cx + 12, headY + 2, t, deep ? 0.34 : 0.5);
      } else if (working && !crying) {
        busy(ctx, a.cx + 12, headY + 6, t);
      } else if (person.state === 'exited') {
        bubble(ctx, a.cx + 16, headY + 2, '×', '#efeae2', '#6b6257');
      }
    }

    bigDesk(ctx, a.cx, a.deskY, {
      screen: look.screen,
      accent: look.accent,
      scan: look.scan ? (now / 60) % 15 : 0,
      // 일하는 동안만 수정이 숨 쉰다. 자는 자리는 잦아든 채로 가만히 있다.
      glow: working ? 0.42 + Math.sin(t * 4.2) * 0.22 : asleep ? 0.18 : 0.3,
      lamp: look.lamp && Math.floor(now / 500) % 2 === 0 ? look.lamp : null,
    });

    if (person.watch) {
      // a small eye above the monitor: this person shows their browser work
      px(ctx, a.cx + 14, a.deskY - 34, 8, 4, '#f0b45a');
      px(ctx, a.cx + 17, a.deskY - 33, 2, 2, '#2b2b33');
    }

    /**
     * 고른 사람은 자리째 밝아진다.
     *
     * 테두리 한 줄을 두르면 "이 사람" 이 아니라 "이 네모" 가 눈에 들어오고,
     * 그루터기와 사람 위로 선이 지나가 그림을 자른다.
     *
     * 바닥에만 깔아 봤더니 그루터기가 95px 라 자리를 거의 다 덮어서 아무것도
     * 안 보였다. 그래서 다 그린 위에 옅게 한 겹 얹는다 — 자리 전체가 은은하게
     * 물들 뿐, 무엇도 가리지 않는다.
     */
    if (this.selectedId === person.id) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      px(ctx, a.x + 2, a.y + 2, CELL_W - 4, CELL_H - 4, '#f0b45a');
      ctx.restore();
    }
  }

  /** A box on the desk taking shape, one flap at a time. */
  _packBox(ctx, x, y, k) {
    const w = 16;
    const h = Math.max(2, Math.round(11 * Math.min(1, k * 1.4)));
    px(ctx, x, y - h, w, h, '#b98a58');
    px(ctx, x, y - h, w, 2, '#cf9f6a');
    px(ctx, x + 7, y - h, 2, h, '#e0cba4');
    if (k > 0.55) px(ctx, x - 3, y - h - 3, 22, 3, '#a9764a'); // flaps folded over
  }

  /**
   * Out the door: down into the corridor, right along it, and through.
   * A person leaving does not cut diagonally across other people's desks, and
   * seeing them take the long way round is most of what sells it.
   */
  _walkPath(g, seat) {
    const drop = { x: seat.cx, y: g.corridorY };
    const along = { x: g.door.cx - 8, y: g.corridorY };
    const out = { x: g.door.x + 14, y: g.corridorY };
    const legs = [
      { from: { x: seat.cx, y: seat.standY + 6 }, to: drop },
      { from: drop, to: along },
      { from: along, to: out },
    ];
    const lengths = legs.map((l) => Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y));
    return { legs, lengths, total: lengths.reduce((a, b) => a + b, 0) || 1 };
  }

  _drawWalkOut(ctx, g, person, leaving, now) {
    const seat = g.ai.cells.find((c) => c.seat === person.seat);
    if (!seat) return;
    const path = this._walkPath(g, seat);
    // Ease out at the end so the last step is a slow one through the doorway.
    const k = leaving.phase === 'gone' ? 1 : leaving.k;
    let travelled = k * path.total;
    let pos = path.legs[path.legs.length - 1].to;
    for (let i = 0; i < path.legs.length; i += 1) {
      if (travelled > path.lengths[i]) { travelled -= path.lengths[i]; continue; }
      const l = path.legs[i];
      const f = path.lengths[i] ? travelled / path.lengths[i] : 1;
      pos = { x: l.from.x + (l.to.x - l.from.x) * f, y: l.from.y + (l.to.y - l.from.y) * f };
      break;
    }

    const av = avatarOf(person.seed, person.sprite);
    // 터벅터벅: a slow cadence with a heavy landing, not a walk cycle.
    const cadence = (now / 1000) * 4.4;
    const alpha = leaving.phase === 'gone' ? Math.max(0, 1 - leaving.k) : 1;
    bigChar(ctx, Math.round(pos.x), Math.round(pos.y), av, {
      alpha,
      step: cadence,
      droop: 1,
      carry: 1,
      crying: leaving.k < 0.45,
      blink: leaving.k >= 0.45,
      bob: Math.max(0, Math.sin(cadence)) * -0.8,
    });
  }

  /**
   * Furnishing the two window bands.
   *
   * Drawn under everything and never interactive — this is set dressing, and
   * its whole job is to make the upper band read as *a place with tables in it*
   * and the lower one as *the couch by the door where things wait*. Colour
   * alone made them two rectangles.
   *
   * Everything is placed off the band's own geometry rather than at fixed
   * coordinates, because both bands resize with the window; and each piece is
   * dropped only when there is room for it, so a small room is bare rather than
   * cluttered with furniture growing through the walls.
   */
  /**
   * 두 밭을 나무 울타리로 두른다.
   *
   * 바닥색만으로는 "여기까지가 이 밭" 이 읽히지 않는다 — 경계는 서 있는 물건이
   * 말해 준다. 위는 묶어 둔 그룹의 밭, 아래는 아직 안 묶은 알들의 밭이다.
   */
  _dressWindows(ctx, g) {
    const left = g.win.x - 4;
    const width = g.win.w + 8;
    const topY = g.win.y - 4;
    const bandBottom = g.win.looseTop - BAND_GAP;
    const looseTop = g.win.looseTop - 2;
    const floor = g.win.y + g.zoneH + 2;

    if (bandBottom - topY > 24) fence(ctx, left, topY, width, bandBottom - topY);
    if (floor - looseTop > 20) fence(ctx, left, looseTop, width, floor - looseTop);

    // 밭 귀퉁이의 나무 한 그루
    if (g.win.w > 150) plant(ctx, g.win.x + g.win.w - 12, bandBottom - 6);
  }

  // ── the windows zone ──────────────────────────────────────────────────────
  _drawWindows(ctx, g, now) {
    const over = (this.drag?.kind === 'win' ? this.drag.over : null) ?? this.dropHint;

    // Hit testing runs back to front, so the order these go in *is* the
    // stacking order: the zone is under the tables, and the tables are under
    // the people sitting at them.
    // Two targets, not one: empty floor in the upper band makes a new table,
    // empty floor in the lower one takes a window back out of its group.
    this.hitboxes.push({
      kind: 'zone', zone: 'groups', x: g.win.x - 6, y: g.win.y - 6,
      w: g.win.w + 12, h: (g.win.looseTop - BAND_GAP / 2) - (g.win.y - 6),
    });
    this.hitboxes.push({
      kind: 'zone', zone: 'loose', x: g.win.x - 6, y: g.win.looseTop - BAND_GAP / 2,
      w: g.win.w + 12, h: (g.win.y + g.zoneH + 4) - (g.win.looseTop - BAND_GAP / 2),
    });

    for (const pod of g.win.pods) {
      this.hitboxes.push({
        kind: 'pod', groupId: pod.group.id,
        x: pod.cx - POD_W / 2 + 6, y: pod.cy - POD_H / 2 + 6, w: POD_W - 12, h: POD_H - 12,
      });
      if (over === pod.group.id) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        px(ctx, pod.cx - POD_W / 2 + 8, pod.cy - POD_H / 2 + 10, POD_W - 16, POD_H - 20, '#f0b45a');
        ctx.restore();
      }
      // 가지를 먼저. 알이 늘면 그 앞에 매달려 가지를 가린다 — 그래서 알이
      // 몇 개 없을 때만 가지가 보인다.
      branch(ctx, pod.branch.x, pod.branch.y, pod.branch.w);
      for (const s of pod.seats) {
        if (s.hangs) stem(ctx, s.x, pod.branch.y + 3, s.y - pod.branch.y - GRAPE_R - 2);
      }
      for (const s of pod.seats) this._drawGrape(ctx, s.person, s.x, s.y, now);
    }

    // The lower band is always drawn, empty or not — it is where you drop a
    // window to take it back out of a group, and you cannot aim at nothing.
    const y = g.win.looseTop;
    const h = g.win.y + g.zoneH - y;
    if (over === 'loose') {
      ctx.save();
      ctx.globalAlpha = 0.12;
      px(ctx, g.win.x + 4, y - 4, g.win.w - 8, h, '#f0b45a');
      ctx.restore();
    }
    // A low rail rather than a hairline: this is a real boundary in the room.
    px(ctx, g.win.x + 2, y - 7, g.win.w - 4, 2, '#00000026');
    px(ctx, g.win.x + 2, y - 7, g.win.w - 4, 1, '#ffffff1c');
    for (const s of g.win.loose) this._drawGrape(ctx, s.person, s.x, s.y, now);
  }

  /**
   * 창 하나 = 포도알 하나.
   *
   * 알의 색은 그 프로그램의 색이다. 사람으로 그리던 때 배지가 하던 일을 이제
   * 알 자체가 한다 — 같은 프로그램이면 같은 색.
   */
  _drawGrape(ctx, person, x, y, now) {
    if (!person) return;
    const dragging = this.drag?.moved && this.drag.kind === 'win' && this.drag.key === person.key;
    if (dragging) return;
    const phase = (hash(person.key) % 100) / 100;
    const t = now / 1000 + phase * 6;
    const cx = Math.round(x);
    const cy = Math.round(y);
    grape(ctx, cx, cy, {
      // 색은 프로그램이 아니라 포도의 것이다 — 프로그램은 이름표의 색 딱지가
      // 말한다. 알마다 톤만 조금씩 달라 송이가 한 덩어리로 뭉치지 않는다.
      tone: hash(person.key) % 4,
      asleep: !!person.minimized,          // 최소화 = 시든 알
      active: !!person.active,             // 지금 앞에 나와 있는 창
      r: GRAPE_R,
      // 바람에 아주 조금. 흔들림이 크면 알이 아니라 풍선이 된다.
      lift: person.minimized ? 0 : Math.sin(t * 1.1) * 0.6,
    });
    this.hitboxes.push({
      kind: 'win', person, x: cx - GRAPE_R - 2, y: cy - GRAPE_R - 2,
      w: GRAPE_R * 2 + 4, h: GRAPE_R * 2 + 4,
    });
  }

  /** Whoever the pointer is carrying, drawn at the cursor. */
  _drawDragged(ctx, now) {
    const d = this.drag;
    const t = now / 1000;
    if (d.kind === 'crew') {
      const person = this.state.crew.find((p) => p.id === d.id);
      if (!person) return;
      const av = avatarOf(person.seed, person.sprite);
      // Held up by the scruff: feet dangling, arms out.
      bigChar(ctx, Math.round(d.x), Math.round(d.y + 14), av, {
        bob: Math.sin(t * 8) * 1.2,
        step: t * 7,
        armLift: 0.5,
        crying: d.over === 'door',
      });
      return;
    }
    const person = this.windowPeople.find((p) => p.key === d.key);
    if (!person) return;
    // 손끝에 매달린 알. 꼭지가 붙어 있어야 딴 것처럼 보인다.
    stem(ctx, Math.round(d.x), Math.round(d.y) - GRAPE_R - 5, 5);
    grape(ctx, Math.round(d.x), Math.round(d.y), {
      tone: hash(person.key) % 4,
      r: GRAPE_R + 1,
      lift: Math.sin(t * 8) * 1.2,
    });
  }

  // ── DOM nameplates ────────────────────────────────────────────────────────
  _syncPlates(g) {
    const seen = new Set();
    for (const person of this.state.crew) {
      const a = g.ai.cells.find((c) => c.seat === person.seat);
      if (!a) continue;
      // Once they are walking the plate would trail them across the room; the
      // activity log carries it from here.
      const leaving = person.state === 'leaving'
        && (performance.now() - (this.leaveClock.get(person.id) ?? performance.now())) > CRY_MS + PACK_MS;
      if (leaving) continue;
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
      // Anchor the plate's bottom-centre just above the tallest headpiece
      // (rabbit ears and the wizard hat both reach ~18px over the head).
      const y = (a.standY - PLATE_LIFT) * this.scale;
      plate.style.transform = `translate(${a.cx * this.scale}px, ${y}px) translate(-50%, -100%)`;
      plate.dataset.state = person.state;
      plate.classList.toggle('sel', this.selectedId === person.id);

      const name = `${person.name}`;
      if (plate.querySelector('b').textContent !== name) plate.querySelector('b').textContent = name;

      // Falling back to the type would just repeat the name, which is the type.
      // An empty caption line is better than an echo.
      const cap = person.state === 'leaving' ? '짐 싸는 중' : (person.caption || '');
      const capEl = plate.querySelector('.cap');
      if (capEl.textContent !== cap) capEl.textContent = cap;
      capEl.classList.toggle('job', !!person.jobName && person.state !== 'leaving');

      const chips = [];
      const s = person.session;
      if (person.state === 'leaving') chips.push('인수인계 중');
      else if (person.approvalCount) chips.push(`승인 ${person.approvalCount}건`);
      else if (s?.currentTool) chips.push(`▶ ${s.currentTool}`);
      if (person.trusted && person.state !== 'leaving') chips.push('알아서');
      if (person.watch) chips.push('지켜보는 중');
      if (person.state === 'exited') chips.push('종료됨');
      const chipEl = plate.querySelector('.chips');
      const chipText = chips.join(' · ');
      if (chipEl.textContent !== chipText) chipEl.textContent = chipText;

      // They finished while you were looking somewhere else. The whole plate is
      // already a link to their conversation, so this is the flag, not a second
      // button — and it goes the moment you open them.
      const done = !!this.state.done?.has(person.id) && person.state !== 'leaving';
      let doneEl = plate.querySelector('.done');
      if (done && !doneEl) {
        doneEl = document.createElement('span');
        doneEl.className = 'done';
        doneEl.textContent = '다했어요';
        plate.appendChild(doneEl);
      } else if (!done && doneEl) {
        doneEl.remove();
      }
    }

    for (const [id, el] of this.plates) {
      if (seen.has(id)) continue;
      el.remove();
      this.plates.delete(id);
    }
  }

  _syncWinPlates(g) {
    const seen = new Set();
    const place = (person, x, y, below, lane = 0) => {
      seen.add(person.key);
      let plate = this.winPlates.get(person.key);
      if (!plate) {
        plate = document.createElement('div');
        plate.className = 'wplate';
        // Which program it is, then which window. A title alone ("2026 예산")
        // does not tell you whether clicking it lands you in Excel or a browser
        // tab, and that is the thing you are actually looking for.
        plate.innerHTML = '<i class="app"></i><b></b>';
        plate.title = '';
        plate.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onWindowClick(person.key);
        });
        this.plateHost.appendChild(plate);
        this.winPlates.set(person.key, plate);
      }
      // 알 바로 위(또는 아래). 32px 는 사람 키였다 — 알은 반지름 7 이라
      // 그만큼 띄우면 이름표가 알과 한참 떨어져 누구 것인지 흐려진다.
      const lift = lane * 13;
      const ty = (below ? y + GRAPE_R + 3 + lift : y - GRAPE_R - 4 - lift) * this.scale;
      plate.style.transform = `translate(${x * this.scale}px, ${ty}px) translate(-50%, ${below ? '0' : '-100%'})`;
      plate.classList.toggle('dim', !!person.minimized);
      plate.classList.toggle('active', !!person.active);
      const b = plate.querySelector('b');
      if (b.textContent !== person.name) b.textContent = person.name;
      const appEl = plate.querySelector('.app');
      const app = person.app ?? '';
      if (appEl.textContent !== app) appEl.textContent = app;
      // Same program, same colour — that is the whole point of the chip.
      const hue = this._hueFor(app);
      if (appEl.dataset.hue !== hue) {
        appEl.dataset.hue = hue;
        appEl.style.background = hue;
        appEl.style.color = inkOn(hue);
      }
      const title = `${person.app} — ${person.name}`;
      if (plate.title !== title) plate.title = title;
    };

    // 송이는 알을 15px 간격으로 붙여 놓는데 이름표는 그 다섯 배 넓다. 알이
    // 네 개를 넘으면 이름표가 서로를 덮어 아무것도 못 읽는 글자 무더기가 된다 —
    // 스무 알짜리 송이를 그려 보고서야 그 꼴을 봤다. 그 위로는 이름표를 걷고,
    // 송이 이름표(이름·개수)와 알에 손을 올렸을 때 뜨는 카드에 맡긴다.
    const LABEL_CAP = 4;
    for (const pod of g.win.pods) {
      if (pod.seats.length > LABEL_CAP) continue;
      for (const s of pod.seats) place(s.person, s.x, s.y, s.y > pod.cy, s.lane);
    }
    // The waiting area is a dense row, so its labels alternate above and below
    // the heads rather than sharing one line.
    // 전부 머리 위에. 30px 로 붙어 있을 땐 한 칸 걸러 아래로 내려야 이름표가
    // 안 겹쳤는데, 이제 가로로 충분히 벌려서 그럴 이유가 없어졌다 — 한 줄에
    // 이름표가 나란히 있는 편이 훨씬 읽기 쉽다.
    g.win.loose.forEach((s) => place(s.person, s.x, s.y, false));

    for (const [key, el] of this.winPlates) {
      if (seen.has(key)) continue;
      el.remove();
      this.winPlates.delete(key);
    }
  }

  /** A group's name and its one button, under its table. */
  _syncGroupPlates(g) {
    const seen = new Set();
    for (const pod of g.win.pods) {
      const id = pod.group.id;
      seen.add(id);
      let plate = this.groupPlates.get(id);
      if (!plate) {
        plate = document.createElement('div');
        plate.className = 'gplate';
        plate.innerHTML = '<b></b><button type="button" class="tiny"></button>';
        plate.querySelector('b').addEventListener('click', (e) => {
          e.stopPropagation();
          this.onGroupRename(id);
        });
        plate.querySelector('button').addEventListener('click', (e) => {
          e.stopPropagation();
          this.onGroupToggle(id);
        });
        this.plateHost.appendChild(plate);
        this.groupPlates.set(id, plate);
      }
      // Clear of the front row's own labels, which hang below their feet.
      const y = (pod.cy + pod.r * 0.7 + 28) * this.scale;
      plate.style.transform = `translate(${pod.cx * this.scale}px, ${y}px) translate(-50%, 0)`;
      plate.classList.toggle(
        'drop',
        (this.drag?.kind === 'win' && this.drag.over === id) || this.dropHint === id,
      );

      const b = plate.querySelector('b');
      const label = `${pod.group.name} · ${pod.members.length}`;
      if (b.textContent !== label) b.textContent = label;
      const btn = plate.querySelector('button');
      const want = pod.group.hidden ? '열기' : '숨기기';
      if (btn.textContent !== want) btn.textContent = want;
      btn.disabled = pod.members.length === 0;
    }
    for (const [id, el] of this.groupPlates) {
      if (seen.has(id)) continue;
      el.remove();
      this.groupPlates.delete(id);
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────
  _toBuffer(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  /** Topmost first: people are pushed after the zone they stand in. */
  _hit(p, kinds = null) {
    for (let i = this.hitboxes.length - 1; i >= 0; i -= 1) {
      const b = this.hitboxes[i];
      if (kinds && !kinds.includes(b.kind)) continue;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
    }
    return null;
  }

  /** Which seat is under a page coordinate — used as a drop target for cards. */
  hitAtClient(clientX, clientY, kinds = null) {
    const r = this.canvas.getBoundingClientRect();
    return this._hit({ x: (clientX - r.left) / this.scale, y: (clientY - r.top) / this.scale }, kinds);
  }

  /**
   * 알 옆에 띄우는 카드.
   *
   * 알 위의 이름표는 좁아서 긴 이름이 말줄임으로 잘린다 — 송이에 여섯 알이
   * 달리면 더 그렇다. 그래서 손이 올라간 알 하나만은 프로그램과 창 이름을
   * 온전히 보여 준다. 알 오른쪽에 붙이되, 자리가 없으면 왼쪽으로 넘긴다.
   */
  _syncGrapeCard(hit) {
    if (!hit) {
      if (this.grapeCard) this.grapeCard.hidden = true;
      return;
    }
    if (!this.grapeCard) {
      const card = document.createElement('div');
      card.className = 'gcard';
      card.innerHTML = '<i class="app"></i><b></b>';
      this.plateHost.appendChild(card);
      this.grapeCard = card;
    }
    const card = this.grapeCard;
    const { person } = hit;
    const appEl = card.querySelector('.app');
    if (appEl.textContent !== (person.app ?? '')) appEl.textContent = person.app ?? '';
    const hue = this._hueFor(person.app);
    if (appEl.dataset.hue !== hue) {
      appEl.dataset.hue = hue;
      appEl.style.background = hue;
      appEl.style.color = inkOn(hue);
    }
    const b = card.querySelector('b');
    if (b.textContent !== person.name) b.textContent = person.name;

    card.hidden = false;
    // 재기 전에 보여야 폭이 나온다. 알 오른쪽이 좁으면 왼쪽으로.
    const cw = card.offsetWidth;
    const stage = this.canvas.width / (window.devicePixelRatio > 1 ? 1 : 1);
    const rightX = (hit.x + hit.w + 6) * this.scale;
    const flip = rightX + cw > stage;
    const x = flip ? (hit.x - 6) * this.scale - cw : rightX;
    const y = (hit.y + hit.h / 2) * this.scale;
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(0, -50%)`;
  }

  _onHover(e) {
    if (this.drag) return;
    const p = this._toBuffer(e);
    const hit = this._hit(p);
    this.hoverSeat = hit?.kind === 'seat' && !hit.person ? hit.seat : null;
    this._syncGrapeCard(hit?.kind === 'win' ? hit : null);
    this.canvas.style.cursor = hit && hit.kind !== 'zone' ? 'pointer' : 'default';

    // Head-patting easter egg: rub back and forth over someone's head.
    if (hit?.kind !== 'seat' || !hit.person) return;
    const dir = Math.sign(e.movementX);
    if (!dir) return;
    const overHead = p.y < hit.y + STAND_Y - Math.round(12 * SPRITE_SCALE);
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

  /**
   * One gesture handles selecting and dragging. Which it was is decided on the
   * way up: below the 8px threshold it was a tap, above it the person was
   * picked up and the tap never happens.
   */
  _onDown(e) {
    if (e.button !== 0) return;
    const p = this._toBuffer(e);
    const hit = this._hit(p);
    this.pressSeat = hit?.kind === 'seat' ? hit.seat : null;
    if (!hit) { this.press = null; return; }

    this.press = { hit, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId };
    // A person leaving is already gone as far as the pointer is concerned.
    if (hit.kind === 'seat' && hit.person && hit.person.state !== 'leaving') {
      this.press.draggable = { kind: 'crew', id: hit.person.id };
    } else if (hit.kind === 'win') {
      this.press.draggable = { kind: 'win', key: hit.person.key };
    }
  }

  _onMove(e) {
    if (!this.press) return;
    const moved = Math.hypot(e.clientX - this.press.x0, e.clientY - this.press.y0);
    if (!this.drag) {
      if (!this.press.draggable || moved < 8) return;
      this.drag = { ...this.press.draggable, moved: true, over: null, x: 0, y: 0 };
      this.pressSeat = null;
      try { this.canvas.setPointerCapture(this.press.pointerId); } catch { /* not captured */ }
      this.canvas.style.cursor = 'grabbing';
    }
    const p = this._toBuffer(e);
    this.drag.x = p.x;
    this.drag.y = p.y;
    this.drag.over = this._dropTarget(p);
  }

  _dropTarget(p) {
    if (this.drag.kind === 'crew') {
      return this._hit(p, ['door']) ? 'door' : null;
    }
    const pod = this._hit(p, ['pod']);
    if (pod) return pod.groupId;
    const zone = this._hit(p, ['zone']);
    if (!zone) return null;
    const geom = this.geom;
    // Below the tables is the waiting area — dropping there means "not part of
    // any of this".
    // 경계는 내용과 무관하게 늘 같은 자리에 있다.
    if (geom && p.y > geom.win.looseTop - BAND_GAP / 2) return 'loose';
    return 'new';
  }

  _onUp(e) {
    const press = this.press;
    const drag = this.drag;
    this.press = null;
    this.drag = null;
    this.pressSeat = null;
    this.canvas.style.cursor = 'default';
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    if (!press) return;

    if (drag) {
      const target = drag.over;
      if (drag.kind === 'crew' && target === 'door') this.onDropAtDoor(drag.id);
      if (drag.kind === 'win' && target) {
        this.onWindowDrop(drag.key, target === 'loose' ? null : target);
      }
      return;
    }

    // A tap.
    const hit = press.hit;
    if (hit.kind === 'seat') {
      if (hit.person) this.onPersonClick(hit.person.id);
      // The sheet grows out of the desk that was clicked, so pass where it was.
      else this.onSeatClick(hit.seat, { x: e.clientX, y: e.clientY });
    } else if (hit.kind === 'win') {
      this.onWindowClick(hit.person.key);
    } else if (hit.kind === 'pod') {
      this.onGroupClick(hit.groupId);
    }
  }
}
