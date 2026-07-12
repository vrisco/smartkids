ALTER TABLE `content_requests` ADD `num_questions` integer;--> statement-breakpoint
ALTER TABLE `content_requests` ADD `points_per_correct` integer;--> statement-breakpoint
ALTER TABLE `content_requests` ADD `modules` integer;--> statement-breakpoint
ALTER TABLE `skills` ADD `coins_per_correct` integer;--> statement-breakpoint
ALTER TABLE `skills` ADD `path_id` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `path_name` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `module_index` integer DEFAULT 0 NOT NULL;