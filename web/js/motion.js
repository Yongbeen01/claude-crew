/**
 * Motion primitives — springs, momentum projection, rubber-banding.
 *
 * The office has no dependencies, so this is a small hand-rolled equivalent of
 * what Motion/Framer would give us. It follows Apple's model rather than the
 * physics one: you describe a spring with *bounce* and *duration*, not mass and
 * stiffness, and every animation is interruptible — `retarget()` keeps the
 * current position **and velocity**, so reversing a gesture mid-flight never
 * hits the "brick wall" a swapped-out animation produces.
 */

/** Apple's damping ratio / response, expressed the way designers think. */
function coefficients(duration, bounce) {
  const zeta = Math.max(0.05, Math.min(1, 1 - bounce)); // 1.0 = no overshoot
  const omega = (2 * Math.PI) / Math.max(0.05, duration); // response, in seconds
  return { zeta, omega };
}

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A running spring. `from` is always the *presentation* value the caller reads
 * off screen, never the logical target — starting from the target is what makes
 * an interrupted animation jump.
 *
 * @returns {{retarget(to:number, v?:number):void, stop():void, value():number, velocity():number, done:boolean}}
 */
export function spring({
  from, to, velocity = 0, duration = 0.4, bounce = 0,
  onUpdate = () => {}, onDone = () => {},
  // Below this the eye cannot tell the difference, so we snap and stop the loop.
  epsilon = 0.05,
}) {
  let x = from;
  let v = velocity;
  let target = to;
  let { zeta, omega } = coefficients(duration, bounce);
  let raf = 0;
  let last = 0;
  const handle = {
    done: false,
    value: () => x,
    velocity: () => v,
    retarget(next, nextV) {
      target = next;
      if (nextV !== undefined) v = nextV; // otherwise velocity carries through
      if (handle.done) { handle.done = false; last = 0; raf = requestAnimationFrame(step); }
    },
    stop() {
      handle.done = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };

  if (reducedMotion()) {
    // Not "no feedback" — just no travel. Land on the value and let the caller's
    // opacity cross-fade carry the meaning.
    x = target; v = 0;
    onUpdate(x, v);
    handle.done = true;
    onDone();
    return handle;
  }

  function step(now) {
    if (!last) last = now;
    // A long frame (tab wake-up, GC) must not be integrated in one go.
    let dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    const h = 1 / 240;
    for (let t = 0; t < dt; t += h) {
      const k = Math.min(h, dt - t);
      const a = -(omega * omega) * (x - target) - 2 * zeta * omega * v;
      v += a * k;
      x += v * k;
    }
    if (Math.abs(x - target) < epsilon && Math.abs(v) < epsilon * 12) {
      x = target; v = 0;
      onUpdate(x, v);
      handle.done = true;
      raf = 0;
      onDone();
      return;
    }
    onUpdate(x, v);
    raf = requestAnimationFrame(step);
  }

  raf = requestAnimationFrame(step);
  return handle;
}

/** Two independent springs — a single spring on 2D distance desyncs when the
 *  axes carry different velocities. */
export function spring2d({ from, to, velocity = { x: 0, y: 0 }, onUpdate, onDone, ...rest }) {
  const pos = { ...from };
  let pending = 2;
  const finish = () => { pending -= 1; if (pending === 0 && onDone) onDone(); };
  const sx = spring({
    ...rest, from: from.x, to: to.x, velocity: velocity.x,
    onUpdate: (val) => { pos.x = val; onUpdate(pos); }, onDone: finish,
  });
  const sy = spring({
    ...rest, from: from.y, to: to.y, velocity: velocity.y,
    onUpdate: (val) => { pos.y = val; onUpdate(pos); }, onDone: finish,
  });
  return {
    stop() { sx.stop(); sy.stop(); },
    retarget(next) { sx.retarget(next.x); sy.retarget(next.y); },
  };
}

/**
 * Where a flick would come to rest — the same exponential decay a scroll view
 * uses. Snap to what is nearest *this* point, not to what is nearest the finger
 * at release; that is what makes a throw feel thrown.
 */
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Progressive resistance past a boundary — resist, never freeze. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Pointer velocity from a short position history. The last sample alone is too
 * noisy to hand a spring; ~60ms of history is enough to feel like the finger.
 */
export class VelocityTracker {
  constructor(windowMs = 60) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(x, y, t = performance.now()) {
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  /** @returns {{x:number, y:number}} px per second */
  get() {
    if (this.samples.length < 2) return { x: 0, y: 0 };
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  reset() { this.samples.length = 0; }
}
