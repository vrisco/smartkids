CREATE TABLE `webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `parent_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webauthn_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`challenge` text NOT NULL,
	`expires_at` text NOT NULL
);
