CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `parent_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`ident` text NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `parent_accounts` ADD `email_verified` integer DEFAULT false NOT NULL;