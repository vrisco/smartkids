ALTER TABLE `rewards` ADD `kind` text DEFAULT 'spend' NOT NULL;--> statement-breakpoint
ALTER TABLE `rewards` ADD `period` text;--> statement-breakpoint
ALTER TABLE `rewards` ADD `limit_count` integer;--> statement-breakpoint
ALTER TABLE `rewards` ADD `limit_period` text DEFAULT 'all' NOT NULL;