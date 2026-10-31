// Live progress: devices push snapshots, websites listen over SSE and send
// commands back.

import { HttpError } from "../http.js";
import * as validate from "../validate.js";

export function registerLive(router, { hub }) {
  router.post("/api/live/push", { auth: "device" }, (ctx) => {
    const { jobs = [], ended = [] } = ctx.body;
    if (!Array.isArray(jobs) || jobs.length > 20 || !Array.isArray(ended) || ended.length > 50) {
      throw validate.bad("Too many live updates in one request.");
    }
    const snapshots = jobs.map(validate.snapshot);
    const finished = ended.map((id) => validate.string(id, { max: 64, pattern: /^[A-Za-z0-9_.:-]+$/, name: "Job id" }));
    return { commands: hub.push(ctx.user.id, ctx.device, snapshots, finished) };
  });

  router.post("/api/live/command", (ctx) => {
    const action = ctx.body.action;
    if (!validate.COMMANDS.includes(action)) throw validate.bad("Unknown action.");
    const deviceId = validate.string(ctx.body.deviceId, { max: 64, name: "Browser" });
    const jobId = validate.string(ctx.body.jobId, { max: 64, name: "Download" });
    if (!hub.command(ctx.user.id, deviceId, jobId, action)) throw new HttpError(404, "That download has already finished.", "gone");
    return { ok: true };
  });

  router.get("/api/events", (ctx, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    hub.subscribe(ctx.user.id, res);
  });
}
