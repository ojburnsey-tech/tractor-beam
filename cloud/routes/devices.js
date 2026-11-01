import { HttpError } from "../http.js";
import * as validate from "../validate.js";
import { deviceJson, userSettings } from "./common.js";
export function registerDevices(router, { db, hub }) {
    async function removeDevice(userId, deviceId) {
        await db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").run(userId, deviceId);
        await db.prepare("DELETE FROM inbox WHERE user_id = ? AND target_device_id = ? AND opened_at IS NULL").run(userId, deviceId);
        await hub.dropDevice(userId, deviceId);
        await hub.emit(userId, "devices", {});
    }
    router.get("/api/devices", async (ctx) => ({
        devices: (await db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").all(ctx.user.id)).map(deviceJson)
    }));
    router.patch("/api/devices/:id", async (ctx) => {
        const name = validate.string(String(ctx.body.name || "").trim(), { min: 1, max: 60, name: "Name" });
        const changed = (await db.prepare("UPDATE devices SET name = ? WHERE user_id = ? AND id = ?").run(name, ctx.user.id, ctx.params.id)).changes;
        if (!changed)
            throw new HttpError(404, "That browser is no longer connected.");
        await hub.emit(ctx.user.id, "devices", {});
        return { ok: true };
    });
    router.delete("/api/devices/:id", async (ctx) => {
        if (!await db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND id = ?").get(ctx.user.id, ctx.params.id)) {
            throw new HttpError(404, "That browser is no longer connected.");
        }
        await removeDevice(ctx.user.id, ctx.params.id);
        return { ok: true };
    });
    router.get("/api/device/me", { auth: "device" }, (ctx) => ({
        device: deviceJson(ctx.device),
        email: ctx.user.email,
        settings: userSettings(ctx.user)
    }));
    router.delete("/api/device/me", { auth: "device" }, async (ctx) => {
        await removeDevice(ctx.user.id, ctx.device.id);
        return { ok: true };
    });
}
