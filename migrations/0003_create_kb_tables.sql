-- Knowledge Base tables for RAG

-- Shared knowledge base chunks (Clio best practices, etc.)
CREATE TABLE `kb_chunks` (
  `id` text PRIMARY KEY NOT NULL,
  `content` text NOT NULL,
  `source` text NOT NULL,
  `section` text,
  `chunk_index` integer NOT NULL,
  `category` text,
  `jurisdiction` text,
  `practice_type` text,
  `firm_size` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kb_chunks_source_idx` ON `kb_chunks` (`source`);
--> statement-breakpoint
CREATE INDEX `kb_chunks_category_idx` ON `kb_chunks` (`category`);
--> statement-breakpoint
CREATE INDEX `kb_chunks_jurisdiction_idx` ON `kb_chunks` (`jurisdiction`);
--> statement-breakpoint
CREATE INDEX `kb_chunks_practice_type_idx` ON `kb_chunks` (`practice_type`);
--> statement-breakpoint
CREATE INDEX `kb_chunks_firm_size_idx` ON `kb_chunks` (`firm_size`);
--> statement-breakpoint

-- Organization-specific context documents
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
