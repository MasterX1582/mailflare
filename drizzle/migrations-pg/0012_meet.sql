CREATE TABLE "meet_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"initiator_id" text NOT NULL,
	"media_kind" text DEFAULT 'video' NOT NULL,
	"end_reason" text,
	"started_at" bigint NOT NULL,
	"answered_at" bigint,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE TABLE "meet_conversation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_message_id" text,
	"joined_at" bigint NOT NULL,
	"last_read_at" bigint
);
--> statement-breakpoint
CREATE TABLE "meet_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'group' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"meeting_id" text,
	"created_by_id" text NOT NULL,
	"last_message_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meet_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'instant' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"calendar_event_id" text,
	"conversation_id" text,
	"scheduled_start_at" bigint,
	"scheduled_end_at" bigint,
	"started_at" bigint,
	"ended_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meet_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"reply_to_id" text,
	"edited_at" bigint,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meet_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"state" text DEFAULT 'invited' NOT NULL,
	"invited_at" bigint NOT NULL,
	"joined_at" bigint,
	"left_at" bigint
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "meet_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" bigint;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "meeting_id" text;--> statement-breakpoint
ALTER TABLE "meet_calls" ADD CONSTRAINT "meet_calls_meeting_id_meet_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meet_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_calls" ADD CONSTRAINT "meet_calls_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_conversation_members" ADD CONSTRAINT "meet_conversation_members_conversation_id_meet_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."meet_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_conversation_members" ADD CONSTRAINT "meet_conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_conversations" ADD CONSTRAINT "meet_conversations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_meetings" ADD CONSTRAINT "meet_meetings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_meetings" ADD CONSTRAINT "meet_meetings_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_messages" ADD CONSTRAINT "meet_messages_conversation_id_meet_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."meet_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_messages" ADD CONSTRAINT "meet_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_participants" ADD CONSTRAINT "meet_participants_meeting_id_meet_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meet_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_participants" ADD CONSTRAINT "meet_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meet_calls_meeting_idx" ON "meet_calls" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meet_calls_initiator_idx" ON "meet_calls" USING btree ("initiator_id");--> statement-breakpoint
CREATE INDEX "meet_calls_started_idx" ON "meet_calls" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meet_conversation_members_conv_user_idx" ON "meet_conversation_members" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "meet_conversation_members_user_idx" ON "meet_conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meet_conversations_meeting_idx" ON "meet_conversations" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meet_conversations_last_message_idx" ON "meet_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meet_meetings_code_idx" ON "meet_meetings" USING btree ("code");--> statement-breakpoint
CREATE INDEX "meet_meetings_owner_idx" ON "meet_meetings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "meet_meetings_calendar_event_idx" ON "meet_meetings" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE INDEX "meet_meetings_status_starts_idx" ON "meet_meetings" USING btree ("status","scheduled_start_at");--> statement-breakpoint
CREATE INDEX "meet_messages_conv_created_idx" ON "meet_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "meet_messages_sender_idx" ON "meet_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meet_participants_meeting_user_idx" ON "meet_participants" USING btree ("meeting_id","user_id");--> statement-breakpoint
CREATE INDEX "meet_participants_user_idx" ON "meet_participants" USING btree ("user_id");
