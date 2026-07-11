CREATE TABLE `child_courses` (
	`child_id` text NOT NULL,
	`course_id` text NOT NULL,
	PRIMARY KEY(`child_id`, `course_id`),
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `child_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`child_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`grade_band` text NOT NULL,
	`name_i18n` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `child_profiles` ADD `username` text;--> statement-breakpoint
CREATE UNIQUE INDEX `child_username_uq` ON `child_profiles` (`username`);--> statement-breakpoint
ALTER TABLE `parent_accounts` ADD `role` text DEFAULT 'tutor' NOT NULL;