CREATE TABLE `exercise_reports` (
	`profile_id` text NOT NULL,
	`exercise_template_id` text NOT NULL,
	`reason` text NOT NULL,
	`answer_given` text,
	`correct` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	PRIMARY KEY(`profile_id`, `exercise_template_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_template_id`) REFERENCES `exercise_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exercise_reports_template_idx` ON `exercise_reports` (`exercise_template_id`);