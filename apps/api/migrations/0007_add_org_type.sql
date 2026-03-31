-- Add organization type column to org table
-- Values: 'law-firm' or 'legal-clinic'

ALTER TABLE `org` ADD COLUMN `org_type` text DEFAULT 'law-firm' CHECK (`org_type` IN ('law-firm', 'legal-clinic'));
