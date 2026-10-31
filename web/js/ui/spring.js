// Critically damped spring (damping ratio 1): no overshoot, settles in about
// `response` seconds, starts from the current value and velocity, so a new
// target can interrupt it at any moment without a jump.
//
// x(t) = target + (x0 + (v0 + ωx0)·t)·e^(−ωt),  ω = 2π / response

export function spring({ from, to, velocity = 0, response = 0.35, onUpdate, onDone }) {
  const omega = (2 * Math.PI) / response;
  const x0 = from - to;
  const start = performance.now();
  let frame = 0;
  let current = from;
  let currentVelocity = velocity;
  let stopped = false;

  function step(now) {
    if (stopped) return;
    const t = (now - start) / 1000;
    const decay = Math.exp(-omega * t);
    const b = velocity + omega * x0;
    current = to + (x0 + b * t) * decay;
    currentVelocity = (b - omega * (x0 + b * t)) * decay;
    onUpdate(current);
    if (Math.abs(current - to) < 0.3 && Math.abs(currentVelocity) < 5) {
      onUpdate(to);
      onDone?.();
      return;
    }
    frame = requestAnimationFrame(step);
  }
  frame = requestAnimationFrame(step);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      return { value: current, velocity: currentVelocity };
    }
  };
}

/** Apple's momentum projection: where a flick would come to rest. */
export function project(velocity, deceleration = 0.998) {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

/** Progressive resistance past a boundary. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
