// A small live speed graph for the download page: the last 90 seconds as a
// line with a light wash beneath, scaled to the fastest second shown. Paused
// seconds (null) break the line. Colours come from the page's CSS tokens so
// it follows light and dark mode.

export function drawSpeedGraph(canvas, values) {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const style = getComputedStyle(canvas);
  const accent = style.getPropertyValue("--accent").trim() || "#007aff";
  const grid = style.getPropertyValue("--separator").trim() || "rgba(0,0,0,0.1)";

  const slots = 90;
  const series = values.slice(-slots);
  const max = Math.max(1, ...series.filter((value) => value !== null));
  const top = 4;
  const bottom = height - 1;
  const x = (index) => ((index + slots - series.length) / (slots - 1)) * width;
  const y = (value) => bottom - (value / max) * (bottom - top);

  context.strokeStyle = grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, bottom + 0.5);
  context.lineTo(width, bottom + 0.5);
  context.stroke();

  // Split into runs separated by pauses.
  const runs = [];
  let run = [];
  series.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push([x(index), y(value)]);
  });
  if (run.length) runs.push(run);

  for (const points of runs) {
    if (points.length < 2) continue;
    context.beginPath();
    context.moveTo(points[0][0], bottom);
    for (const [px, py] of points) context.lineTo(px, py);
    context.lineTo(points[points.length - 1][0], bottom);
    context.closePath();
    context.globalAlpha = 0.12;
    context.fillStyle = accent;
    context.fill();
    context.globalAlpha = 1;

    context.beginPath();
    points.forEach(([px, py], index) => (index ? context.lineTo(px, py) : context.moveTo(px, py)));
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }
}
