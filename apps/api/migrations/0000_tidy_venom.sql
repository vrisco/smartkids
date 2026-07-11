CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`exercise_template_id` text NOT NULL,
	`content_version` text NOT NULL,
	`correct` integer NOT NULL,
	`response_time_ms` integer,
	`difficulty_served` real,
	`ts` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_template_id`) REFERENCES `exercise_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `child_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar` text DEFAULT 'orbi' NOT NULL,
	`birth_year` integer,
	`grade_band` text NOT NULL,
	`login_pin_hash` text,
	`preferred_locale` text DEFAULT 'es' NOT NULL,
	`region` text,
	FOREIGN KEY (`parent_id`) REFERENCES `parent_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`grade_band` text,
	`version` text NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exercise_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`type` text NOT NULL,
	`language` text DEFAULT 'es' NOT NULL,
	`content_version` text DEFAULT '1.0.0' NOT NULL,
	`stem` text NOT NULL,
	`payload` text NOT NULL,
	`difficulty_numeric` real DEFAULT 0.5 NOT NULL,
	`difficulty_level` text DEFAULT 'medium' NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `parent_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`locale_format` text DEFAULT 'es-ES' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parent_accounts_email_unique` ON `parent_accounts` (`email`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reward_id`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`cost` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`name_i18n` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_prerequisites` (
	`skill_id` text NOT NULL,
	`prerequisite_id` text NOT NULL,
	PRIMARY KEY(`skill_id`, `prerequisite_id`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prerequisite_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skill_progress` (
	`profile_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`mastery_score` real DEFAULT 0 NOT NULL,
	`consecutive_correct` integer DEFAULT 0 NOT NULL,
	`total_attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`fsrs` text,
	PRIMARY KEY(`profile_id`, `skill_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`grade_band` text NOT NULL,
	`name_i18n` text NOT NULL,
	`difficulty_base` real DEFAULT 0.4 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`name_i18n` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallet_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
