CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `devices_user` ON `devices` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_identity_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `downloads` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`device_id` text,
	`seq` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`state` text NOT NULL,
	`kind` text,
	`method` text,
	`mode` text,
	`live` integer DEFAULT 0 NOT NULL,
	`bytes` integer,
	`received` integer,
	`media_duration` real,
	`elapsed_ms` integer,
	`active_ms` integer,
	`avg_speed` real,
	`peak_speed` real,
	`height` integer,
	`codecs` text,
	`container` text,
	`fps` real,
	`concurrency` integer,
	`concurrency_auto` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`samples` text,
	`sealed` text NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `downloads_seq` ON `downloads` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_user` ON `events` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_device_id` text,
	`sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`opened_at` integer,
	`opened_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_user` ON `inbox` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `link_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`name` text NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`device_id` text,
	`token` text,
	`wrapped_key` text,
	`claim_attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `live_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`job_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commands_device` ON `live_commands` (`user_id`,`device_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_jobs` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`job_id` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `device_id`, `job_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tombstones` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tombstones_seq` ON `tombstones` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`auth_hash` text NOT NULL,
	`kdf_iterations` integer NOT NULL,
	`vault` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_account` ON `users` (1);--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity_unique` ON `users` (`email`);