CREATE TABLE `child_study_docs` (
	`child_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	PRIMARY KEY(`child_id`, `doc_id`),
	FOREIGN KEY (`child_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`doc_id`) REFERENCES `study_docs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `child_study_docs_doc_idx` ON `child_study_docs` (`doc_id`);--> statement-breakpoint
CREATE TABLE `study_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text,
	`subject_id` text NOT NULL,
	`grade_band` text NOT NULL,
	`title` text NOT NULL,
	`language` text DEFAULT 'es' NOT NULL,
	`body` text NOT NULL,
	`stats` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`skill_id` text,
	`path_id` text,
	`course_id` text,
	`module_index` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`request_id` text,
	`child_answers` integer DEFAULT true NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `study_docs_owner_idx` ON `study_docs` (`owner_id`);--> statement-breakpoint
CREATE INDEX `study_docs_subject_grade_idx` ON `study_docs` (`subject_id`,`grade_band`,`retired`);--> statement-breakpoint
CREATE INDEX `study_docs_request_idx` ON `study_docs` (`request_id`);--> statement-breakpoint
CREATE INDEX `study_docs_skill_idx` ON `study_docs` (`skill_id`);--> statement-breakpoint
CREATE INDEX `study_docs_course_idx` ON `study_docs` (`course_id`);--> statement-breakpoint
ALTER TABLE `content_requests` ADD `outputs` text;--> statement-breakpoint
ALTER TABLE `content_requests` ADD `doc_count` integer;