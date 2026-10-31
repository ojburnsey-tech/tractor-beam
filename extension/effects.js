function createStarfield(canvas) {
  const context = canvas.getContext("2d");
  const stars = Array.from({ length: 170 }, () => ({
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    depth: Math.random(),
    warm: Math.random() < 0.14,
    twinkle: 0.55 + Math.random() * 0.45
  }));
  let width = 0;
  let height = 0;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(stretch) {
    context.clearRect(0, 0, width, height);
    const centreX = width / 2;
    const centreY = height * 0.42;
    for (const star of stars) {
      const near = 1 - star.depth;
      const x = centreX + star.x * width * 0.62;
      const y = centreY + star.y * height * 0.72;
      const radius = 0.35 + near * 1.15;
      const alpha = (0.25 + near * 0.7) * star.twinkle;
      const colour = star.warm ? "255, 226, 194" : "220, 232, 255";
      if (stretch > 0.01) {
        const pull = stretch * (0.18 + near * 0.55);
        context.strokeStyle = `rgba(${colour}, ${alpha})`;
        context.lineWidth = radius * 1.4;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - (x - centreX) * pull, y - (y - centreY) * pull);
        context.stroke();
      } else {
        context.fillStyle = `rgba(${colour}, ${alpha})`;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  return { resize, draw };
}

function playArrival(starfield, onDone) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    starfield.draw(0);
    onDone();
    return;
  }
  const duration = 680;
  const start = performance.now();
  let revealed = false;
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    const stretch = Math.pow(1 - progress, 3) * 1.25;
    starfield.draw(stretch);
    if (!revealed && progress > 0.45) {
      revealed = true;
      onDone();
    }
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

export function startBackdrop() {
  const starfield = createStarfield(document.getElementById("stars"));
  starfield.resize();
  playArrival(starfield, () => document.body.classList.add("ready"));
  new ResizeObserver(() => {
    starfield.resize();
    if (document.body.classList.contains("ready")) starfield.draw(0);
  }).observe(document.body);
}
