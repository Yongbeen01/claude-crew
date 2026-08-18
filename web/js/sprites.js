/**
 * Top-down pixel art, in the style of a 2D office RPG.
 *
 * Everything is drawn into the 1x back-buffer with whole-pixel rects; the office
 * view then upscales with nearest-neighbour, so the art keeps hard pixel edges.
 * There are no image assets anywhere — every shape below is fillRect.
 * Screen y grows downward = "further from the viewer" is up.
 */

export const TILE = 22;

export function px(ctx, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Rect with the corner pixels knocked out — reads as "rounded" at this size. */
export function soft(ctx, x, y, w, h, color) {
  px(ctx, x + 1, y, w - 2, 1, color);
  px(ctx, x, y + 1, w, h - 2, color);
  px(ctx, x + 1, y + h - 1, w - 2, 1, color);
}

export function shadow(ctx, cx, cy, w = 14, h = 5) {
  ctx.save();
  ctx.globalAlpha = 0.16;
  soft(ctx, cx - w / 2, cy - h / 2, w, h, '#000000');
  ctx.restore();
}

export function darken(hex, amt = 0.22) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amt));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amt));
  const b = Math.max(0, (n & 255) * (1 - amt));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function lighten(hex, amt = 0.18) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + 255 * amt);
  const g = Math.min(255, ((n >> 8) & 255) + 255 * amt);
  const b = Math.min(255, (n & 255) + 255 * amt);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ── palettes ────────────────────────────────────────────────────────────────
const SKIN = ['#f5d0aa', '#e8b184', '#d29468', '#a9754f', '#fae2ca'];
const HAIR = ['#33291f', '#5e3b24', '#a8622c', '#dcb970', '#3b3f6b', '#7b3f5e', '#2b5a4a', '#8d8d99'];
const SHIRT = ['#5b8def', '#5fd39a', '#f0b45a', '#e0705b', '#a77bd8', '#4ec3d9', '#e88fc0', '#7d8798'];
const HAIRSTYLE = ['bob', 'short', 'ponytail', 'side', 'bun', 'long'];

/**
 * Same id always gets the same face. The persona decides the headpiece, so two
 * 표고버섯 still look like different people wearing the same hat.
 */
export function avatarOf(seed, type = '') {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return {
    skin: SKIN[n % SKIN.length],
    hair: HAIR[(n >>> 3) % HAIR.length],
    shirt: type === 'wizard' ? '#5b4b8a' : SHIRT[(n >>> 6) % SHIRT.length],
    style: HAIRSTYLE[(n >>> 9) % HAIRSTYLE.length],
    phase: (n % 100) / 100,
    type,
  };
}

// ── floor & room ────────────────────────────────────────────────────────────
const PLANK_A = '#b98a58';
const PLANK_B = '#b0804e';
const PLANK_LINE = '#9a6c3f';

export function floorPatch(ctx, x, y, w, h) {
  px(ctx, x, y, w, h, PLANK_A);
  const ph = TILE;
  for (let row = 0, i = 0; row < h; row += ph, i += 1) {
    const rh = Math.min(ph, h - row);
    if (i % 2) px(ctx, x, y + row, w, rh, PLANK_B);
    px(ctx, x, y + row, w, 1, PLANK_LINE);
    px(ctx, x, y + row + 1, w, 1, lighten(i % 2 ? PLANK_B : PLANK_A, 0.05));
    // staggered seams — long planks read as a wooden floor
    for (let sx = i % 2 ? TILE * 2 : TILE * 3.5; sx < w; sx += TILE * 4) {
      px(ctx, x + sx, y + row, 1, rh, PLANK_LINE);
    }
  }
}

/** Area rug under a workstation: solid field, darker border, woven edge. */
export function rug(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.globalAlpha = 0.62;
  soft(ctx, x, y, w, h, darken(color, 0.22));
  soft(ctx, x + 2, y + 2, w - 4, h - 4, color);
  soft(ctx, x + 5, y + 5, w - 10, h - 10, lighten(color, 0.07));
  for (let i = 4; i < w - 4; i += 6) px(ctx, x + i, y + 1, 3, 1, lighten(color, 0.16));
  for (let i = 4; i < w - 4; i += 6) px(ctx, x + i, y + h - 2, 3, 1, lighten(color, 0.16));
  ctx.restore();
}

/** The room shell: back wall along the top, thin walls on the other sides. */
export function room(ctx, x, y, w, h, wallTop, wall) {
  const WALL = '#e7dfd2';
  const WALL_D = '#cfc4b3';
  const TRIM = '#8d7a63';

  px(ctx, x, y, w, wallTop, WALL);
  for (let i = 0; i < w; i += TILE) px(ctx, x + i, y, 1, wallTop - 4, WALL_D);
  px(ctx, x, y + wallTop - 5, w, 2, WALL_D);
  px(ctx, x, y + wallTop - 3, w, 3, TRIM);

  px(ctx, x, y + wallTop, wall, h - wallTop, WALL_D);
  px(ctx, x + w - wall, y + wallTop, wall, h - wallTop, WALL_D);
  px(ctx, x, y + h - wall, w, wall, TRIM);
  px(ctx, x, y + h - wall, w, 1, darken(TRIM, 0.25));
}

// ── wall decorations ────────────────────────────────────────────────────────
export function shelf(ctx, x, y) {
  px(ctx, x, y, 40, 20, '#8a5f3a');
  px(ctx, x, y, 40, 2, '#a9764a');
  px(ctx, x + 1, y + 3, 38, 7, '#5d3f27');
  px(ctx, x + 1, y + 12, 38, 7, '#5d3f27');
  const books = ['#d05a5a', '#5ab0d0', '#e0b45a', '#7fd1a0', '#b08fd8'];
  for (let i = 0; i < 12; i += 1) {
    px(ctx, x + 2 + i * 3, y + 4, 2, 5, books[i % books.length]);
    px(ctx, x + 3 + i * 3, y + 13, 2, 5, books[(i + 2) % books.length]);
  }
}

export function whiteboard(ctx, x, y) {
  px(ctx, x, y, 46, 24, '#3a3f4c');
  px(ctx, x + 1, y + 1, 44, 22, '#f6f6f2');
  px(ctx, x + 4, y + 5, 24, 2, '#7fb0d8');
  px(ctx, x + 4, y + 10, 32, 2, '#d88a8a');
  px(ctx, x + 4, y + 15, 18, 2, '#8ad8a0');
}

export function wallClock(ctx, cx, cy, date) {
  px(ctx, cx - 7, cy - 7, 14, 14, '#3a3f4c');
  px(ctx, cx - 6, cy - 6, 12, 12, '#f7f5ee');
  const m = ((date.getMinutes() / 60) * Math.PI * 2) - Math.PI / 2;
  const h = ((date.getHours() % 12) / 12) * Math.PI * 2 - Math.PI / 2;
  px(ctx, cx + Math.round(Math.cos(m) * 4), cy + Math.round(Math.sin(m) * 4), 1, 1, '#2b2b33');
  px(ctx, cx + Math.round(Math.cos(m) * 2), cy + Math.round(Math.sin(m) * 2), 1, 1, '#2b2b33');
  px(ctx, cx + Math.round(Math.cos(h) * 2), cy + Math.round(Math.sin(h) * 2), 2, 2, '#2b2b33');
  px(ctx, cx, cy, 1, 1, '#e0705b');
}

export function windowPane(ctx, x, y) {
  px(ctx, x, y, 44, 22, '#6f5b45');
  px(ctx, x + 2, y + 2, 40, 18, '#8fd0ee');
  px(ctx, x + 2, y + 2, 40, 6, '#b6e5f8');
  px(ctx, x + 21, y + 2, 2, 18, '#6f5b45');
  px(ctx, x + 2, y + 10, 40, 2, '#6f5b45');
}

export function plant(ctx, cx, cy) {
  shadow(ctx, cx, cy, 16, 6);
  px(ctx, cx - 6, cy - 10, 12, 10, '#b6743f');
  px(ctx, cx - 6, cy - 10, 12, 2, '#cf8a52');
  px(ctx, cx - 7, cy - 12, 14, 3, '#a0653a');
  px(ctx, cx - 2, cy - 22, 3, 12, '#3f7a4a');
  px(ctx, cx - 9, cy - 24, 7, 5, '#4f9c5c');
  px(ctx, cx + 2, cy - 27, 8, 6, '#5cb06a');
  px(ctx, cx - 6, cy - 30, 6, 5, '#4f9c5c');
  px(ctx, cx + 1, cy - 33, 5, 4, '#6cc47a');
}

export function cooler(ctx, cx, cy) {
  shadow(ctx, cx, cy, 18, 6);
  px(ctx, cx - 8, cy - 30, 16, 30, '#dfe5ee');
  px(ctx, cx - 8, cy - 30, 16, 12, '#8fd3f0');
  px(ctx, cx - 8, cy - 30, 16, 4, '#b6e5f8');
  px(ctx, cx - 4, cy - 16, 8, 5, '#9aa4b5');
  px(ctx, cx - 8, cy - 4, 16, 4, '#b6bfcd');
}

export function printer(ctx, cx, cy) {
  shadow(ctx, cx, cy, 22, 6);
  px(ctx, cx - 11, cy - 20, 22, 20, '#4a5162');
  px(ctx, cx - 11, cy - 20, 22, 5, '#5f6879');
  px(ctx, cx - 8, cy - 14, 16, 3, '#2b303c');
  px(ctx, cx - 7, cy - 9, 14, 6, '#f2f2ee');
  px(ctx, cx + 5, cy - 18, 3, 2, '#5fd39a');
}

/** Two-seat couch, front-on. The lounge corner of the room. */
export function sofa(ctx, cx, cy, color = '#7b6a9c') {
  const dark = darken(color, 0.28);
  const light = lighten(color, 0.14);
  shadow(ctx, cx, cy, 40, 7);
  px(ctx, cx - 19, cy - 20, 38, 12, dark);      // backrest
  px(ctx, cx - 19, cy - 20, 38, 3, light);
  px(ctx, cx - 21, cy - 16, 5, 14, color);      // arms
  px(ctx, cx + 16, cy - 16, 5, 14, color);
  px(ctx, cx - 16, cy - 10, 32, 9, color);      // seat
  px(ctx, cx - 16, cy - 10, 32, 2, light);
  px(ctx, cx - 1, cy - 9, 2, 8, dark);          // cushion seam
  px(ctx, cx - 15, cy - 1, 4, 3, '#3a2c22');    // feet
  px(ctx, cx + 11, cy - 1, 4, 3, '#3a2c22');
}

/** Low table — sits in front of the sofa with a mug on it. */
export function coffeeTable(ctx, cx, cy, color = '#9a7550') {
  shadow(ctx, cx, cy, 24, 5);
  px(ctx, cx - 12, cy - 10, 24, 5, color);
  px(ctx, cx - 12, cy - 10, 24, 2, lighten(color, 0.16));
  px(ctx, cx - 10, cy - 5, 2, 5, darken(color, 0.3));
  px(ctx, cx + 8, cy - 5, 2, 5, darken(color, 0.3));
  px(ctx, cx - 3, cy - 14, 5, 4, '#f2f2ee');    // mug
  px(ctx, cx + 2, cy - 13, 2, 2, '#f2f2ee');    // handle
}

/** Filing cabinet — three drawers, the archive of a working room. */
export function cabinet(ctx, cx, cy, color = '#8a8f9c') {
  shadow(ctx, cx, cy, 20, 6);
  px(ctx, cx - 9, cy - 30, 18, 30, color);
  px(ctx, cx - 9, cy - 30, 18, 3, lighten(color, 0.18));
  for (let i = 0; i < 3; i += 1) {
    const y = cy - 27 + i * 9;
    px(ctx, cx - 7, y, 14, 7, darken(color, 0.16));
    px(ctx, cx - 2, y + 3, 4, 2, lighten(color, 0.3));
  }
}

// ── furniture ───────────────────────────────────────────────────────────────
/** Office chair, seen from above-behind: backrest on top, seat below. */
export function chair(ctx, cx, cy, color = '#454c5e') {
  const dark = darken(color, 0.3);
  soft(ctx, cx - 10, cy - 14, 20, 10, color);
  px(ctx, cx - 9, cy - 13, 18, 3, lighten(color, 0.1));
  soft(ctx, cx - 9, cy - 5, 18, 10, dark);
  px(ctx, cx - 1, cy + 5, 2, 3, '#2b303c');
}

/** An empty desk — the click target for hiring someone into that seat. */
export function emptyDesk(ctx, cx, cy, { hover = false } = {}) {
  desk(ctx, cx, cy, { screen: '#1a1d22', accent: '#3a3f4c', scan: 0 });
  const y = cy - 30;
  ctx.save();
  ctx.globalAlpha = hover ? 0.95 : 0.55;
  const ink = hover ? '#f0b45a' : '#e7dfd2';
  // a plus sign floating over the seat
  px(ctx, cx - 1, y - 22, 3, 11, ink);
  px(ctx, cx - 5, y - 18, 11, 3, ink);
  ctx.restore();
}

/**
 * Desk seen from above. (cx, cy) is the middle of its front edge; the worker
 * sits behind it, so the surface is drawn after the character and hides
 * everything below their chest.
 */
export function desk(ctx, cx, cy, { screen = '#1b2430', accent = '#7fd1c0', scan = 0, lamp = null } = {}) {
  const W = 76;
  const H = 30;
  const x = cx - W / 2;
  const y = cy - H;

  px(ctx, x, y + H - 3, W, 3, '#6b4a2c'); // front edge
  px(ctx, x, y, W, H - 3, '#a97d52'); // surface
  px(ctx, x, y, W, 2, '#c49a6a'); // far edge highlight
  px(ctx, x + 2, y + 2, W - 4, 1, '#b98a5e');

  // monitor, right hand side
  const mx = cx + 16;
  px(ctx, mx - 13, y + 3, 26, 18, '#2b303c');
  px(ctx, mx - 11, y + 5, 22, 13, screen);
  for (let i = 0; i < 5; i += 1) {
    const w = 3 + ((i * 5 + Math.floor(scan)) % 15);
    px(ctx, mx - 10, y + 6 + i * 2.4, w, 1, accent);
  }
  px(ctx, mx - 3, y + 21, 6, 2, '#22262f');
  px(ctx, mx - 7, y + 23, 14, 2, '#3a3f4c');

  // keyboard + mouse + mug + papers
  px(ctx, cx - 26, y + 17, 20, 6, '#d5dae4');
  px(ctx, cx - 25, y + 18, 18, 1, '#9aa3b1');
  px(ctx, cx - 25, y + 20, 18, 1, '#9aa3b1');
  px(ctx, cx - 4, y + 18, 4, 5, '#d5dae4');
  px(ctx, cx - 30, y + 6, 6, 6, '#e0705b');
  px(ctx, cx - 29, y + 7, 4, 2, '#f0a090');
  px(ctx, cx - 24, y + 8, 2, 2, '#e0705b');
  px(ctx, cx - 22, y + 4, 12, 9, '#f2eee2');
  px(ctx, cx - 21, y + 6, 9, 1, '#b9b3a4');
  px(ctx, cx - 21, y + 9, 7, 1, '#b9b3a4');

  if (lamp) {
    px(ctx, cx + 30, y + 4, 6, 4, lamp);
    px(ctx, cx + 32, y + 8, 2, 8, '#8a8f9c');
    px(ctx, cx + 29, y + 16, 8, 2, '#8a8f9c');
  }
}

/**
 * The way out, cut into the right-hand wall.
 *
 * Seen from above like everything else: the frame is the wall's thickness, the
 * leaf has swung outward, and the mat on the floor is what makes it read as a
 * threshold rather than a hole. The lamp over it is the only green in the room.
 */
export function door(ctx, x, y, h, wall, { hover = false } = {}) {
  const FRAME = '#8a6a48';
  const DARK = '#191510';

  // the opening itself — the room's wall stops here
  px(ctx, x, y, wall, h, DARK);
  px(ctx, x - 1, y - 4, wall + 1, 4, FRAME);
  px(ctx, x - 1, y + h, wall + 1, 4, FRAME);
  px(ctx, x - 1, y - 4, 1, h + 8, darken(FRAME, 0.3));

  // the leaf, swung out into the dark
  px(ctx, x + wall, y + 2, 3, h - 8, '#8a6a48');
  px(ctx, x + wall, y + 2, 3, 2, '#a9825a');
  px(ctx, x + wall + 1, y + h - 12, 1, 3, '#e8d7bd'); // handle

  // The daylight on the floor is what makes this read as a way out rather than
  // a dark panel. It brightens when someone is being carried toward it.
  ctx.save();
  ctx.globalAlpha = hover ? 0.5 : 0.24;
  for (let i = 0; i < 18; i += 1) {
    const inset = Math.round(i * 0.35);
    px(ctx, x - 18 + i, y + 2 + inset, 1, h - 4 - inset * 2, '#f6e3b8');
  }
  ctx.restore();

  // threshold mat
  px(ctx, x - 8, y + 3, 8, h - 6, hover ? '#6a5a3a' : '#4a4132');
  px(ctx, x - 8, y + 3, 1, h - 6, hover ? '#f0b45a' : '#5f5646');

  // EXIT lamp over the frame, and its glow on the wall
  px(ctx, x - 12, y - 13, 12, 7, '#1d2a1c');
  px(ctx, x - 11, y - 12, 10, 5, hover ? '#a6f0bd' : '#5fd39a');
  px(ctx, x - 9, y - 11, 2, 3, '#1d2a1c');
  px(ctx, x - 6, y - 11, 2, 3, '#1d2a1c');
}

/**
 * A cardboard box. (cx, cy) is the middle of its bottom edge.
 * `grow` 0..1 packs it as it appears; the size caps are how a box being filled
 * on a desk and a box being carried out can be the same drawing.
 */
export function box(ctx, cx, cy, grow = 1, maxW = 16, maxH = 12) {
  const g = Math.max(0, Math.min(1, grow));
  if (g <= 0.02) return;
  const w = Math.max(3, Math.round((maxW - 2) * g) + 2);
  const h = Math.max(3, Math.round((maxH - 2) * g) + 2);
  const x = Math.round(cx - w / 2);
  const y = cy - h;
  px(ctx, x, y, w, h, '#b98a58');
  px(ctx, x, y, w, 2, '#cf9f6a');
  px(ctx, x + 1, y + 2, w - 2, 1, '#8a5f3a');
  // packing tape down the middle
  px(ctx, cx - 1, y, 2, h, '#e0cba4');
  px(ctx, x, y + h - 1, w, 1, '#7a5230');
}

/**
 * The round table a group of windows sits at.
 *
 * A flat filled ellipse reads as a rock, so the top third is lifted, the front
 * edge is dropped, and the whole thing gets a one-pixel rim — that outline is
 * what makes it a piece of furniture rather than a stain on the floor.
 */
export function roundTable(ctx, cx, cy, r, color = '#8a6f5a') {
  shadow(ctx, cx, cy + r - 2, r * 2 - 2, 6);
  const rim = darken(color, 0.45);
  for (let dy = -r; dy <= r; dy += 1) {
    const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (!half) continue;
    const tone = dy < -r * 0.3
      ? lighten(color, 0.14)
      : dy > r * 0.55 ? darken(color, 0.24) : color;
    px(ctx, cx - half, cy + dy, half * 2, 1, tone);
    px(ctx, cx - half, cy + dy, 1, 1, rim);
    px(ctx, cx + half - 1, cy + dy, 1, 1, rim);
  }
  px(ctx, cx - Math.round(r * 0.7), cy - r, Math.round(r * 1.4), 1, rim);
  px(ctx, cx - Math.round(r * 0.7), cy + r, Math.round(r * 1.4), 1, rim);
  // a couple of papers and a mug, so the table reads as in use
  px(ctx, cx - 5, cy - 3, 7, 5, '#f2eee2');
  px(ctx, cx - 4, cy - 1, 5, 1, '#b9b3a4');
  px(ctx, cx + 3, cy - 1, 4, 4, '#e0705b');
}

/**
 * The floor of a zone.
 *
 * A tint alone disappears into the wood grain, so this lays down a flat carpet
 * first and tints that — the two zones then read as two different floors rather
 * than as two slightly different browns. The corner ticks are what say "this
 * area is bounded" without drawing a box around it.
 */
export function zoneFloor(ctx, x, y, w, h, tint) {
  ctx.save();
  ctx.globalAlpha = 0.34;
  px(ctx, x, y, w, h, '#2a2018');
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.2;
  px(ctx, x, y, w, h, tint);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.08;
  for (let i = 4; i < h; i += 8) px(ctx, x, y + i, w, 1, '#000000');
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1], [x + w - 1, y, -1, 1], [x, y + h - 1, 1, -1], [x + w - 1, y + h - 1, -1, -1],
  ]) {
    px(ctx, dx > 0 ? cx : cx - 9, cy, 10, 1, tint);
    px(ctx, cx, dy > 0 ? cy : cy - 9, 1, 10, tint);
  }
  ctx.restore();
}

/** Waist-high partition between the two zones. */
export function partition(ctx, x, y, h) {
  px(ctx, x, y, 4, h, '#cfc4b3');
  px(ctx, x, y, 4, 2, '#e7dfd2');
  px(ctx, x, y + h - 2, 4, 2, '#8d7a63');
  for (let i = 6; i < h - 6; i += 12) px(ctx, x + 1, y + i, 2, 5, '#b6a894');
}

// ── headpieces ──────────────────────────────────────────────────────────────
/**
 * What makes a 토끼 a 토끼. Drawn on top of the hair, so the face and hair
 * palette underneath still vary per person.
 */
function headpiece(ctx, hx, headY, av) {
  switch (av.type) {
    case 'rabbit': {
      const ear = '#f2e8e0';
      const inner = '#f0a8b4';
      px(ctx, hx - 5, headY - 14, 3, 13, ear);
      px(ctx, hx - 4, headY - 12, 1, 8, inner);
      px(ctx, hx + 2, headY - 16, 3, 15, ear);
      px(ctx, hx + 3, headY - 14, 1, 9, inner);
      break;
    }
    case 'wizard': {
      const hat = '#3d3268';
      const band = '#f0b45a';
      px(ctx, hx - 9, headY - 3, 18, 2, hat); // brim
      px(ctx, hx - 7, headY - 5, 14, 2, hat);
      px(ctx, hx - 7, headY - 5, 14, 1, band);
      px(ctx, hx - 5, headY - 9, 10, 4, hat);
      px(ctx, hx - 3, headY - 13, 6, 4, hat);
      px(ctx, hx - 1, headY - 16, 3, 3, hat);
      px(ctx, hx, headY - 18, 2, 2, band); // star at the tip
      break;
    }
    case 'shiitake': {
      const cap = '#8a5a3a';
      const capD = '#6d442b';
      const spot = '#e8d7bd';
      px(ctx, hx - 10, headY - 3, 20, 3, cap);
      px(ctx, hx - 8, headY - 6, 16, 3, cap);
      px(ctx, hx - 5, headY - 8, 10, 2, lighten(cap, 0.08));
      px(ctx, hx - 10, headY, 20, 1, capD);
      px(ctx, hx - 6, headY - 5, 2, 2, spot);
      px(ctx, hx + 1, headY - 6, 3, 2, spot);
      px(ctx, hx - 1, headY - 3, 2, 1, spot);
      break;
    }
    case 'designer': {
      const beret = '#c8484f';
      px(ctx, hx - 8, headY - 4, 15, 4, beret);
      px(ctx, hx - 6, headY - 6, 11, 2, beret);
      px(ctx, hx - 8, headY - 1, 15, 1, darken(beret, 0.3));
      px(ctx, hx + 5, headY - 7, 2, 2, darken(beret, 0.2)); // stalk
      break;
    }
    default:
      break;
  }
}

// ── people ──────────────────────────────────────────────────────────────────
/**
 * A worker facing the viewer. (cx, cy) is the floor point under them.
 * 26px tall, 18px wide with arms.
 */
export function character(ctx, cx, cy, av, opts = {}) {
  const {
    bob = 0,
    blink = false,
    armLift = 0,
    tilt = 0,
    alpha = 1,
    typing = 0,
    patted = false,
    ruffle = 0,
    /** walking phase in radians — legs alternate, 0 stands still */
    step = 0,
    /** 0..1, shoulders and head sink: the difference between walking and trudging */
    droop = 0,
    crying = false,
    /** 0..1, arms come up in front to hold a box */
    carry = 0,
    /** a small colour tag on the chest — which app a window-person belongs to */
    badge = null,
  } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;

  const sink = Math.round(droop * 2);
  const y = Math.round(cy + bob);
  const hairDark = darken(av.hair, 0.28);
  const shirtDark = darken(av.shirt, 0.24);
  const skinDark = darken(av.skin, 0.16);
  const hx = cx + tilt;

  shadow(ctx, cx, cy, 18, 6);

  // legs — one lifts while the other plants
  const gait = step ? Math.sin(step) : 0;
  const lLift = Math.round(Math.max(0, gait) * 2);
  const rLift = Math.round(Math.max(0, -gait) * 2);
  px(ctx, cx - 5, y - 5 - lLift, 4, 5, '#3c4356');
  px(ctx, cx + 1, y - 5 - rLift, 4, 5, '#3c4356');
  px(ctx, cx - 6, y - 1 - lLift, 5, 2, '#23283a');
  px(ctx, cx + 1, y - 1 - rLift, 5, 2, '#23283a');

  // torso
  const torsoY = y - 15 + sink;
  soft(ctx, cx - 7, torsoY, 14, 11, av.shirt);
  px(ctx, cx - 7, torsoY + 8, 14, 3, shirtDark);
  px(ctx, cx - 2, torsoY, 4, 4, lighten(av.shirt, 0.12)); // collar
  if (badge) {
    px(ctx, cx + 1, torsoY + 4, 4, 3, '#f2eee2');
    px(ctx, cx + 2, torsoY + 5, 2, 1, badge);
  }

  // arms — they rest on the desk while typing, and come up to carry a box
  const swing = typing ? Math.round(Math.sin(typing) * 1) : 0;
  const hug = Math.round(carry * 4);
  const lArmY = torsoY + 2 + swing - hug;
  const rArmY = Math.round(torsoY + 2 - armLift * 12 - swing - hug);
  px(ctx, cx - 10 + hug, lArmY, 3, 8, av.shirt);
  px(ctx, cx - 10 + hug, lArmY + 8, 3, 3, av.skin);
  px(ctx, cx + 7 - hug, rArmY, 3, 8, av.shirt);
  px(ctx, cx + 7 - hug, rArmY + 8, 3, 3, av.skin);
  if (carry > 0.05) {
    // Held against the chest, then the hands drawn back over its edges — a box
    // with no hands on it looks stuck to the shirt rather than carried.
    box(ctx, cx, torsoY + 11, carry, 13, 9);
    px(ctx, cx - 8, torsoY + 5, 3, 3, av.skin);
    px(ctx, cx + 5, torsoY + 5, 3, 3, av.skin);
  }

  // neck + head
  px(ctx, cx - 2, y - 17 + sink, 4, 3, skinDark);
  const headY = y - 27 + sink;
  soft(ctx, hx - 7, headY, 14, 12, av.skin);
  px(ctx, hx - 7, headY + 10, 14, 2, skinDark);

  // hair — a parting plus one highlight line reads as "combed"
  soft(ctx, hx - 7, headY - 2, 14, 5, av.hair);
  px(ctx, hx - 8, headY + 1, 2, 6, av.hair);
  px(ctx, hx + 6, headY + 1, 2, 6, av.hair);
  px(ctx, hx - 5, headY - 1, 7, 1, lighten(av.hair, 0.1));
  if (av.style === 'bob') {
    px(ctx, hx - 9, headY + 2, 2, 8, hairDark);
    px(ctx, hx + 7, headY + 2, 2, 8, hairDark);
  }
  if (av.style === 'short') px(ctx, hx - 6, headY + 2, 12, 2, av.hair);
  if (av.style === 'ponytail') {
    px(ctx, hx + 7, headY + 2, 3, 12, hairDark);
    px(ctx, hx - 6, headY + 2, 5, 2, av.hair);
  }
  if (av.style === 'side') {
    px(ctx, hx - 6, headY + 2, 9, 2, av.hair);
    px(ctx, hx + 3, headY + 2, 3, 1, hairDark);
  }
  if (av.style === 'bun') {
    px(ctx, hx - 3, headY - 5, 6, 3, hairDark);
    px(ctx, hx - 2, headY - 6, 4, 1, av.hair);
  }
  if (av.style === 'long') {
    px(ctx, hx - 9, headY + 2, 2, 14, hairDark);
    px(ctx, hx + 7, headY + 2, 2, 14, hairDark);
  }

  // after a head pat the hair sticks out, then settles
  if (ruffle > 0) {
    const k = Math.max(1, Math.round(ruffle * 3));
    px(ctx, hx - 6, headY - 2 - k, 2, 2 + k, av.hair);
    px(ctx, hx - 1, headY - 3 - k, 2, 3 + k, av.hair);
    px(ctx, hx + 4, headY - 2 - k, 2, 2 + k, av.hair);
    px(ctx, hx - 9, headY - 1, 2, 2, hairDark);
    px(ctx, hx + 8, headY, 2, 2, hairDark);
  }

  headpiece(ctx, hx, headY, av);

  // face
  if (crying) {
    // Eyes squeezed shut — the arch points the other way from the contented one.
    px(ctx, hx - 5, headY + 5, 1, 1, '#2b2b33');
    px(ctx, hx - 4, headY + 6, 2, 1, '#2b2b33');
    px(ctx, hx - 2, headY + 5, 1, 1, '#2b2b33');
    px(ctx, hx + 1, headY + 5, 1, 1, '#2b2b33');
    px(ctx, hx + 2, headY + 6, 2, 1, '#2b2b33');
    px(ctx, hx + 4, headY + 5, 1, 1, '#2b2b33');
    // and two drops on their way down, out of step with each other
    const fall = (Math.abs(gait) * 6) | 0;
    px(ctx, hx - 4, headY + 8 + fall, 1, 2, '#8fd0ee');
    px(ctx, hx + 3, headY + 7 + ((fall + 3) % 7), 1, 2, '#8fd0ee');
    px(ctx, hx - 6, headY + 7, 2, 1, '#ff9f9f');
    px(ctx, hx + 4, headY + 7, 2, 1, '#ff9f9f');
    // downturned mouth
    px(ctx, hx - 1, headY + 9, 2, 1, darken(av.skin, 0.45));
    px(ctx, hx - 2, headY + 10, 1, 1, darken(av.skin, 0.45));
    px(ctx, hx + 1, headY + 10, 1, 1, darken(av.skin, 0.45));
    ctx.restore();
    return headY;
  }
  if (patted) {
    // eyes closed contentedly — a shallow arch, raised in the middle
    px(ctx, hx - 5, headY + 6, 1, 1, '#2b2b33');
    px(ctx, hx - 4, headY + 5, 2, 1, '#2b2b33');
    px(ctx, hx - 2, headY + 6, 1, 1, '#2b2b33');
    px(ctx, hx + 1, headY + 6, 1, 1, '#2b2b33');
    px(ctx, hx + 2, headY + 5, 2, 1, '#2b2b33');
    px(ctx, hx + 4, headY + 6, 1, 1, '#2b2b33');
  } else if (!blink) {
    px(ctx, hx - 4, headY + 5, 2, 3, '#2b2b33');
    px(ctx, hx + 2, headY + 5, 2, 3, '#2b2b33');
    px(ctx, hx - 4, headY + 5, 1, 1, '#ffffff');
    px(ctx, hx + 2, headY + 5, 1, 1, '#ffffff');
  } else {
    px(ctx, hx - 4, headY + 6, 2, 1, '#2b2b33');
    px(ctx, hx + 2, headY + 6, 2, 1, '#2b2b33');
  }
  px(ctx, hx - 6, headY + 7, 2, 1, patted ? '#ff8f8f' : '#f0a0a0');
  px(ctx, hx + 4, headY + 7, 2, 1, patted ? '#ff8f8f' : '#f0a0a0');
  if (patted) {
    const mouth = darken(av.skin, 0.4);
    px(ctx, hx - 1, headY + 9, 2, 1, mouth);
    px(ctx, hx - 2, headY + 8, 1, 1, mouth);
    px(ctx, hx + 1, headY + 8, 1, 1, mouth);
  } else {
    px(ctx, hx - 1, headY + 8, 2, 1, darken(av.skin, 0.35));
  }

  ctx.restore();
  return headY;
}

/** Speech / status bubble with a single glyph. */
export function bubble(ctx, cx, cy, glyph, bg = '#ffffff', fg = '#2b2b33') {
  const w = 18;
  const h = 16;
  soft(ctx, cx - w / 2, cy - h, w, h, bg);
  px(ctx, cx - 3, cy - 1, 4, 4, bg);
  px(ctx, cx - 2, cy + 2, 2, 1, bg);
  ctx.fillStyle = fg;
  ctx.font = 'bold 12px Pretendard, "Malgun Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, cx, cy - h / 2 + 1);
}
