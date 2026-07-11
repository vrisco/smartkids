CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `parent_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
