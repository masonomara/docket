-- Subscription and permissions tables

-- Organization membership with roles
CREATE TABLE `org_members` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `org_id` text NOT NULL,
  `role` text NOT NULL DEFAULT 'member' CHECK (`role` IN ('admin', 'member')),
  `is_owner` integer NOT NULL DEFAULT 0,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_members_user_org_idx` ON `org_members` (`user_id`, `org_id`);
--> statement-breakpoint
CREATE INDEX `org_members_org_idx` ON `org_members` (`org_id`);
--> statement-breakpoint

-- Stripe subscription tracking
CREATE TABLE `subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL UNIQUE,
  `tier` text NOT NULL DEFAULT 'free' CHECK (`tier` IN ('free', 'starter', 'professional', 'enterprise')),
  `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active', 'past_due', 'canceled', 'trialing')),
  `stripe_customer_id` text,
  `stripe_subscription_id` text,
  `current_period_start` integer,
  `current_period_end` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscriptions_org_idx` ON `subscriptions` (`org_id`);
--> statement-breakpoint

-- Tier-based feature limits
CREATE TABLE `tier_limits` (
  `tier` text PRIMARY KEY NOT NULL CHECK (`tier` IN ('free', 'starter', 'professional', 'enterprise')),
  `max_users` integer NOT NULL,
  `max_queries_per_day` integer NOT NULL,
  `max_context_docs` integer NOT NULL,
  `max_doc_size_mb` integer NOT NULL,
  `clio_read` integer NOT NULL DEFAULT 1,
  `clio_write` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint

-- Seed tier limits (-1 means unlimited)
INSERT INTO `tier_limits` (`tier`, `max_users`, `max_queries_per_day`, `max_context_docs`, `max_doc_size_mb`, `clio_read`, `clio_write`)
VALUES
  ('free', 1, 25, 5, 10, 1, 0),
  ('starter', 5, 100, 25, 25, 1, 1),
  ('professional', 25, 500, 100, 50, 1, 1),
  ('enterprise', -1, -1, -1, 100, 1, 1);
--> statement-breakpoint

-- Role-based permissions (owner permissions checked via is_owner flag)
CREATE TABLE `role_permissions` (
  `role` text NOT NULL CHECK (`role` IN ('admin', 'member')),
  `permission` text NOT NULL,
  `allowed` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`role`, `permission`)
);
--> statement-breakpoint

-- Seed role permissions
INSERT INTO `role_permissions` (`role`, `permission`, `allowed`)
VALUES
  -- Admin: can invite and manage context, full Clio access
  ('admin', 'org_invite', 1),
  ('admin', 'org_context_manage', 1),
  ('admin', 'clio_read', 1),
  ('admin', 'clio_create', 1),
  ('admin', 'clio_update', 1),
  ('admin', 'clio_delete', 1),
  -- Member: read only
  ('member', 'org_invite', 0),
  ('member', 'org_context_manage', 0),
  ('member', 'clio_read', 1),
  ('member', 'clio_create', 0),
  ('member', 'clio_update', 0),
  ('member', 'clio_delete', 0);
--> statement-breakpoint

-- Auto-update updated_at on modification
CREATE TRIGGER `subscriptions_updated_at`
AFTER UPDATE ON `subscriptions`
FOR EACH ROW
WHEN NEW.`updated_at` = OLD.`updated_at`
BEGIN
  UPDATE `subscriptions` SET `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
  WHERE `id` = OLD.`id`;
END;
