-- Add uploaded_by column for GDPR compliance (Article 17 - Right to Erasure)
-- Tracks which user uploaded each org context file for deletion requests

ALTER TABLE `org_context_chunks` ADD COLUMN `uploaded_by` text REFERENCES `user`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `org_context_chunks_uploaded_by_idx` ON `org_context_chunks` (`uploaded_by`);
