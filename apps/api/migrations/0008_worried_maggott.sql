CREATE TABLE `child_skills` (
	`child_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`child_id`, `skill_id`),
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_request_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `content_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`child_id` text,
	`subject_id` text,
	`grade_band` text,
	`title` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`note` text,
	`skill_id` text,
	`package_id` text,
	`exercise_count` integer,
	`created_at` text NOT NULL,
	`published_at` text,
	`notified_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `parent_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `content_packages` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `owner_id` text;