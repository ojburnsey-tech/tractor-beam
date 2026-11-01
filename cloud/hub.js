import { newId } from "./security.js";
export class CloudHub {
    constructor(db) { this.db = db; }
    async emit(userId, event, data = {}) {
        const now = Date.now();
        await this.db.batch([
            this.db.prepare("INSERT INTO events (user_id, event, payload, created_at) VALUES (?, ?, ?, ?)").statement(userId, event, JSON.stringify(data), now),
            this.db.prepare("DELETE FROM events WHERE user_id = ? AND created_at < ?").statement(userId, now - 120000)
        ]);
    }
    async push(userId, device, jobs, ended) {
        const now = Date.now();
        const statements = [];
        for (const job of jobs) {
            const payload = { ...job, deviceId: device.id, deviceName: device.name, receivedAt: now };
            statements.push(this.db.prepare(`INSERT INTO live_jobs (user_id, device_id, job_id, payload, received_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id, job_id) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at`)
                .statement(userId, device.id, job.jobId, JSON.stringify(payload), now));
        }
        for (const id of ended)
            statements.push(this.db.prepare("DELETE FROM live_jobs WHERE user_id = ? AND device_id = ? AND job_id = ?").statement(userId, device.id, id));
        statements.push(this.db.prepare("DELETE FROM live_jobs WHERE user_id = ? AND received_at < ?").statement(userId, now - 15000));
        statements.push(this.db.prepare("DELETE FROM live_commands WHERE user_id = ? AND created_at < ?").statement(userId, now - 30000));
        statements.push(this.db.prepare("DELETE FROM live_commands WHERE user_id = ? AND device_id = ? RETURNING job_id, action").statement(userId, device.id));
        const results = await this.db.batch(statements);
        return results.at(-1).results.map((row) => ({ jobId: row.job_id, action: row.action }));
    }
    async command(userId, deviceId, jobId, action) {
        const now = Date.now();
        const result = await this.db.prepare(`INSERT INTO live_commands (id, user_id, device_id, job_id, action, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM live_jobs WHERE user_id = ? AND device_id = ? AND job_id = ? AND received_at > ?)
      AND (SELECT COUNT(*) FROM live_commands WHERE user_id = ? AND device_id = ? AND created_at > ?) < 20`)
            .run(newId(), userId, deviceId, jobId, action, now, userId, deviceId, jobId, now - 15000, userId, deviceId, now - 30000);
        return result.changes > 0;
    }
    async dropDevice(userId, deviceId) {
        await this.db.batch([
            this.db.prepare("DELETE FROM live_jobs WHERE user_id = ? AND device_id = ?").statement(userId, deviceId),
            this.db.prepare("DELETE FROM live_commands WHERE user_id = ? AND device_id = ?").statement(userId, deviceId)
        ]);
    }
    async list(userId) {
        const rows = await this.db.prepare("SELECT payload FROM live_jobs WHERE user_id = ? AND received_at > ? ORDER BY received_at").all(userId, Date.now() - 15000);
        return rows.map((row) => JSON.parse(row.payload));
    }
    async stream(ctx, headers) {
        const userId = ctx.user.id;
        const db = this.db;
        const hub = this;
        const first = await db.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM events WHERE user_id = ?").get(userId);
        let cursor = first.cursor;
        let timer;
        let stopped = false;
        let controller;
        const encoder = new TextEncoder();
        const write = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        function close() {
            if (stopped)
                return;
            stopped = true;
            clearTimeout(timer);
            ctx.request.signal.removeEventListener("abort", close);
            try {
                controller.close();
            }
            catch { }
        }
        const started = Date.now();
        async function tick() {
            if (stopped)
                return;
            try {
                const session = await db.prepare("SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?").get(ctx.session.id, Date.now());
                if (!session) {
                    write("signed-out", {});
                    close();
                    return;
                }
                const rows = await db.prepare("SELECT id, event, payload FROM events WHERE user_id = ? AND id > ? ORDER BY id").all(userId, cursor);
                if (stopped)
                    return;
                for (const row of rows) {
                    write(row.event, JSON.parse(row.payload));
                    cursor = row.id;
                }
                write("live", { jobs: await hub.list(userId) });
                if (Date.now() - started > 55000) {
                    close();
                    return;
                }
                timer = setTimeout(tick, 2000);
            }
            catch {
                close();
            }
        }
        const stream = new ReadableStream({
            start(value) { controller = value; controller.enqueue(encoder.encode("retry: 1500\n\n")); timer = setTimeout(tick, 0); },
            cancel() { stopped = true; clearTimeout(timer); ctx.request.signal.removeEventListener("abort", close); }
        });
        ctx.request.signal.addEventListener("abort", close, { once: true });
        const resultHeaders = new Headers(headers);
        resultHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
        resultHeaders.set("Cache-Control", "no-store");
        resultHeaders.set("X-Accel-Buffering", "no");
        return new Response(stream, { headers: resultHeaders });
    }
}
