import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex, AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const meta = sqliteTable("meta", {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
});
export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    auth_hash: text("auth_hash").notNull(),
    kdf_iterations: integer("kdf_iterations").notNull(),
    vault: text("vault").notNull(),
    settings: text("settings").notNull().default("{}"),
    created_at: integer("created_at").notNull(),
    seq: integer("seq").notNull().default(0),
}, (table) => [uniqueIndex("personal_account").on(sql `1`), uniqueIndex("users_identity_unique").on(table.email)]);
export const sessions = sqliteTable("sessions", {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    created_at: integer("created_at").notNull(),
    last_seen: integer("last_seen").notNull(),
    expires_at: integer("expires_at").notNull(),
    user_agent: text("user_agent").notNull().default(""),
}, (table) => [index("sessions_user").on(table.user_id)]);
export const devices = sqliteTable("devices", {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    browser: text("browser").notNull().default(""),
    version: text("version").notNull().default(""),
    token_hash: text("token_hash").notNull(),
    created_at: integer("created_at").notNull(),
    last_seen: integer("last_seen").notNull(),
}, (table) => [index("devices_user").on(table.user_id), uniqueIndex("devices_identity_unique").on(table.token_hash)]);
export const link_requests = sqliteTable("link_requests", {
    id: text("id").primaryKey(),
    secret_hash: text("secret_hash").notNull(),
    public_key: text("public_key").notNull(),
    name: text("name").notNull(),
    browser: text("browser").notNull().default(""),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    user_id: text("user_id").references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    device_id: text("device_id"),
    token: text("token"),
    wrapped_key: text("wrapped_key"),
    claim_attempts: integer("claim_attempts").notNull().default(0),
});
export const downloads = sqliteTable("downloads", {
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    device_id: text("device_id"),
    seq: integer("seq").notNull(),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
    state: text("state").notNull(),
    kind: text("kind"),
    method: text("method"),
    mode: text("mode"),
    live: integer("live").notNull().default(0),
    bytes: integer("bytes"),
    received: integer("received"),
    media_duration: real("media_duration"),
    elapsed_ms: integer("elapsed_ms"),
    active_ms: integer("active_ms"),
    avg_speed: real("avg_speed"),
    peak_speed: real("peak_speed"),
    height: integer("height"),
    codecs: text("codecs"),
    container: text("container"),
    fps: real("fps"),
    concurrency: integer("concurrency"),
    concurrency_auto: integer("concurrency_auto").notNull().default(0),
    error_code: text("error_code"),
    samples: text("samples"),
    sealed: text("sealed").notNull(),
    notified: integer("notified").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.user_id, table.id] }), index("downloads_seq").on(table.user_id, table.seq)]);
export const tombstones = sqliteTable("tombstones", {
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    deleted_at: integer("deleted_at").notNull(),
}, (table) => [primaryKey({ columns: [table.user_id, table.id] }), index("tombstones_seq").on(table.user_id, table.seq)]);
export const inbox = sqliteTable("inbox", {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    target_device_id: text("target_device_id"),
    sealed: text("sealed").notNull(),
    created_at: integer("created_at").notNull(),
    opened_at: integer("opened_at"),
    opened_by: text("opened_by"),
}, (table) => [index("inbox_user").on(table.user_id, table.created_at)]);
export const push_subscriptions = sqliteTable("push_subscriptions", {
    endpoint: text("endpoint").primaryKey(),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    label: text("label").notNull().default(""),
    created_at: integer("created_at").notNull(),
});
export const live_jobs = sqliteTable("live_jobs", {
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    device_id: text("device_id").notNull().references((): AnySQLiteColumn => devices.id, { onDelete: "cascade" }),
    job_id: text("job_id").notNull(),
    payload: text("payload").notNull(),
    received_at: integer("received_at").notNull(),
}, (table) => [primaryKey({ columns: [table.user_id, table.device_id, table.job_id] })]);
export const live_commands = sqliteTable("live_commands", {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    device_id: text("device_id").notNull().references((): AnySQLiteColumn => devices.id, { onDelete: "cascade" }),
    job_id: text("job_id").notNull(),
    action: text("action").notNull(),
    created_at: integer("created_at").notNull(),
}, (table) => [index("commands_device").on(table.user_id, table.device_id, table.created_at)]);
export const events = sqliteTable("events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: text("user_id").notNull().references((): AnySQLiteColumn => users.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: text("payload").notNull(),
    created_at: integer("created_at").notNull(),
}, (table) => [index("events_user").on(table.user_id, table.id)]);
export const rate_limits = sqliteTable("rate_limits", {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    window_start: integer("window_start").notNull(),
    expires_at: integer("expires_at").notNull(),
});
