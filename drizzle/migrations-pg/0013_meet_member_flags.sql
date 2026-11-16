ALTER TABLE "meet_conversation_members" ADD COLUMN "muted_at" timestamp;
ALTER TABLE "meet_conversation_members" ADD COLUMN "pinned_at" timestamp;
CREATE TABLE "meet_user_blocks" (
	"id" varchar(191) PRIMARY KEY NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"blocked_user_id" varchar(191) NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "meet_user_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
	CONSTRAINT "meet_user_blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX "meet_user_blocks_user_blocked_idx" ON "meet_user_blocks" ("user_id","blocked_user_id");
CREATE INDEX "meet_user_blocks_blocked_idx" ON "meet_user_blocks" ("blocked_user_id");
