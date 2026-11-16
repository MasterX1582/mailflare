CREATE TABLE `meet_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`initiator_id` text NOT NULL,
	`media_kind` text DEFAULT 'video' NOT NULL,
	`end_reason` text,
	`started_at` integer NOT NULL,
	`answered_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meet_meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meet_conversation_members` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`last_read_message_id` text,
	`joined_at` integer NOT NULL,
	`last_read_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `meet_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meet_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'group' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`meeting_id` text,
	`created_by_id` text NOT NULL,
	`last_message_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meet_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'instant' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`calendar_event_id` text,
	`conversation_id` text,
	`scheduled_start_at` integer,
	`scheduled_end_at` integer,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `meet_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`reply_to_id` text,
	`edited_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `meet_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meet_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'participant' NOT NULL,
	`state` text DEFAULT 'invited' NOT NULL,
	`invited_at` integer NOT NULL,
	`joined_at` integer,
	`left_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meet_meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `meet_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` integer;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `meeting_id` text;
--> statement-breakpoint
CREATE INDEX `meet_calls_meeting_idx` ON `meet_calls` (`meeting_id`);
--> statement-breakpoint
CREATE INDEX `meet_calls_initiator_idx` ON `meet_calls` (`initiator_id`);
--> statement-breakpoint
CREATE INDEX `meet_calls_started_idx` ON `meet_calls` (`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `meet_conversation_members_conv_user_idx` ON `meet_conversation_members` (`conversation_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `meet_conversation_members_user_idx` ON `meet_conversation_members` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `meet_conversations_meeting_idx` ON `meet_conversations` (`meeting_id`);
--> statement-breakpoint
CREATE INDEX `meet_conversations_last_message_idx` ON `meet_conversations` (`last_message_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `meet_meetings_code_idx` ON `meet_meetings` (`code`);
--> statement-breakpoint
CREATE INDEX `meet_meetings_owner_idx` ON `meet_meetings` (`owner_id`);
--> statement-breakpoint
CREATE INDEX `meet_meetings_calendar_event_idx` ON `meet_meetings` (`calendar_event_id`);
--> statement-breakpoint
CREATE INDEX `meet_meetings_status_starts_idx` ON `meet_meetings` (`status`,`scheduled_start_at`);
--> statement-breakpoint
CREATE INDEX `meet_messages_conv_created_idx` ON `meet_messages` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `meet_messages_sender_idx` ON `meet_messages` (`sender_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `meet_participants_meeting_user_idx` ON `meet_participants` (`meeting_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `meet_participants_user_idx` ON `meet_participants` (`user_id`);
