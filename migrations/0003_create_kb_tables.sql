-- Migration: Knowledge Base Tables
-- Tables: kb_chunks, kb_formulas, kb_benchmarks, org_context_chunks

CREATE TABLE `kb_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`source` text NOT NULL,
	`section` text,
	`chunk_index` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kb_chunks_source_idx` ON `kb_chunks` (`source`);
--> statement-breakpoint
CREATE TABLE `kb_formulas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`formula` text NOT NULL,
	`description` text,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kb_formulas_source_idx` ON `kb_formulas` (`source`);
--> statement-breakpoint
CREATE TABLE `kb_benchmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`unit` text,
	`context` text,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kb_benchmarks_source_idx` ON `kb_benchmarks` (`source`);
--> statement-breakpoint
CREATE TABLE `org_context_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`content` text NOT NULL,
	`source` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `org_context_chunks_org_idx` ON `org_context_chunks` (`org_id`);
--> statement-breakpoint
CREATE INDEX `org_context_chunks_file_idx` ON `org_context_chunks` (`org_id`, `file_id`);
