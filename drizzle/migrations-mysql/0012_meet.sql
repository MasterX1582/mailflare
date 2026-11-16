CREATE TABLE `meet_calls` (
	`id` varchar(191) NOT NULL,
	`meeting_id` varchar(191) NOT NULL,
	`initiator_id` varchar(191) NOT NULL,
	`media_kind` varchar(64) NOT NULL DEFAULT 'video',
	`end_reason` longtext,
	`started_at` bigint NOT NULL,
	`answered_at` bigint,
	`ended_at` bigint,
	CONSTRAINT `meet_calls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meet_conversation_members` (
	`id` varchar(191) NOT NULL,
	`conversation_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`role` varchar(64) NOT NULL DEFAULT 'member',
	`last_read_message_id` longtext,
	`joined_at` bigint NOT NULL,
	`last_read_at` bigint,
	CONSTRAINT `meet_conversation_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `meet_conversation_members_conv_user_idx` UNIQUE(`conversation_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `meet_conversations` (
	`id` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL DEFAULT 'group',
	`name` longtext NOT NULL DEFAULT (''),
	`meeting_id` varchar(191),
	`created_by_id` varchar(191) NOT NULL,
	`last_message_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meet_conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `meet_conversations_meeting_idx` UNIQUE(`meeting_id`)
);
--> statement-breakpoint
CREATE TABLE `meet_meetings` (
	`id` varchar(191) NOT NULL,
	`code` varchar(191) NOT NULL,
	`owner_id` varchar(191) NOT NULL,
	`title` longtext NOT NULL DEFAULT (''),
	`kind` varchar(64) NOT NULL DEFAULT 'instant',
	`status` varchar(64) NOT NULL DEFAULT 'scheduled',
	`calendar_event_id` varchar(191),
	`conversation_id` longtext,
	`scheduled_start_at` bigint,
	`scheduled_end_at` bigint,
	`started_at` bigint,
	`ended_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `meet_meetings_id` PRIMARY KEY(`id`),
	CONSTRAINT `meet_meetings_code_idx` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `meet_messages` (
	`id` varchar(191) NOT NULL,
	`conversation_id` varchar(191) NOT NULL,
	`sender_id` varchar(191) NOT NULL,
	`type` varchar(64) NOT NULL DEFAULT 'text',
	`body` longtext NOT NULL DEFAULT (''),
	`reply_to_id` longtext,
	`edited_at` bigint,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `meet_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meet_participants` (
	`id` varchar(191) NOT NULL,
	`meeting_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`role` varchar(64) NOT NULL DEFAULT 'participant',
	`state` varchar(64) NOT NULL DEFAULT 'invited',
	`invited_at` bigint NOT NULL,
	`joined_at` bigint,
	`left_at` bigint,
	CONSTRAINT `meet_participants_id` PRIMARY KEY(`id`),
	CONSTRAINT `meet_participants_meeting_user_idx` UNIQUE(`meeting_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `meet_enabled` boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` bigint;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `meeting_id` varchar(191);--> statement-breakpoint
ALTER TABLE `meet_calls` ADD CONSTRAINT `meet_calls_meeting_id_meet_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meet_meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_calls` ADD CONSTRAINT `meet_calls_initiator_id_users_id_fk` FOREIGN KEY (`initiator_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_conversation_members` ADD CONSTRAINT `meet_conversation_members_conversation_id_meet_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `meet_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_conversation_members` ADD CONSTRAINT `meet_conversation_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_conversations` ADD CONSTRAINT `meet_conversations_created_by_id_users_id_fk` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_meetings` ADD CONSTRAINT `meet_meetings_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_meetings` ADD CONSTRAINT `meet_meetings_calendar_event_id_calendar_events_id_fk` FOREIGN KEY (`calendar_event_id`) REFERENCES `calendar_events`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_messages` ADD CONSTRAINT `meet_messages_conversation_id_meet_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `meet_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_messages` ADD CONSTRAINT `meet_messages_sender_id_users_id_fk` FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_participants` ADD CONSTRAINT `meet_participants_meeting_id_meet_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meet_meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meet_participants` ADD CONSTRAINT `meet_participants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `meet_calls_meeting_idx` ON `meet_calls` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meet_calls_initiator_idx` ON `meet_calls` (`initiator_id`);--> statement-breakpoint
CREATE INDEX `meet_calls_started_idx` ON `meet_calls` (`started_at`);--> statement-breakpoint
CREATE INDEX `meet_conversation_members_user_idx` ON `meet_conversation_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `meet_conversations_last_message_idx` ON `meet_conversations` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `meet_meetings_owner_idx` ON `meet_meetings` (`owner_id`);--> statement-breakpoint
CREATE INDEX `meet_meetings_calendar_event_idx` ON `meet_meetings` (`calendar_event_id`);--> statement-breakpoint
CREATE INDEX `meet_meetings_status_starts_idx` ON `meet_meetings` (`status`,`scheduled_start_at`);--> statement-breakpoint
CREATE INDEX `meet_messages_conv_created_idx` ON `meet_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meet_messages_sender_idx` ON `meet_messages` (`sender_id`);--> statement-breakpoint
CREATE INDEX `meet_participants_user_idx` ON `meet_participants` (`user_id`);
