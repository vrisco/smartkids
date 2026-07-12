CREATE TABLE `coin_awards` (
	`profile_id` text NOT NULL,
	`exercise_template_id` text NOT NULL,
	`ts` text NOT NULL,
	PRIMARY KEY(`profile_id`, `exercise_template_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_template_id`) REFERENCES `exercise_templates`(`id`) ON UPDATE no action ON DELETE no action
);
