ALTER TABLE `meet_conversation_members` ADD `muted_at` integer;--> statement-breakpoint
ALTER TABLE `meet_conversation_members` ADD `pinned_at` integer;--> statement-breakpoint
CREATE TABLE `meet_user_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`blocked_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meet_user_blocks_user_blocked_idx` ON `meet_user_blocks` (`user_id`,`blocked_user_id`);--> statement-breakpoint
CREATE INDEX `meet_user_blocks_blocked_idx` ON `meet_user_blocks` (`blocked_user_id`);
