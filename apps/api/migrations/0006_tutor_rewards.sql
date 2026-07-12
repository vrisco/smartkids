CREATE TABLE `child_rewards` (
	`child_id` text NOT NULL,
	`reward_id` text NOT NULL,
	PRIMARY KEY(`child_id`, `reward_id`),
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reward_id`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `rewards` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `rewards` ADD `icon` text;