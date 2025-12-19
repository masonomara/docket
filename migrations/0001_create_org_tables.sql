-- Migration: Organization Tables
-- Tables: org, workspace_bindings, channel_user_links, invitations, api_keys

CREATE TABLE `org` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL CHECK (`channel_type` IN ('teams', 'slack')),
	`workspace_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_bindings_workspace_idx` ON `workspace_bindings` (`channel_type`, `workspace_id`);
--> statement-breakpoint
CREATE INDEX `workspace_bindings_org_idx` ON `workspace_bindings` (`org_id`);
--> statement-breakpoint
CREATE TABLE `channel_user_links` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL CHECK (`channel_type` IN ('teams', 'slack')),
	`channel_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_user_links_channel_idx` ON `channel_user_links` (`channel_type`, `channel_user_id`);
--> statement-breakpoint
CREATE INDEX `channel_user_links_user_idx` ON `channel_user_links` (`user_id`);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL DEFAULT 'member' CHECK (`role` IN ('owner', 'admin', 'member')),
	`invited_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);
--> statement-breakpoint
CREATE INDEX `invitations_org_idx` ON `invitations` (`org_id`);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);
--> statement-breakpoint
CREATE INDEX `api_keys_org_idx` ON `api_keys` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);
