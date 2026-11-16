import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { meetConversationMembers, users } from "@/db/schema";
import type { MeetNotification } from "@/lib/realtime/types";

/**
 * Fan a Meet payload out to each user's realtime sockets. The same
 * `/api/realtime` channel that carries mail notifications delivers these;
 * clients pick them up by `type`.
 */
export async function notifyMeetUsers(env: CloudflareEnv, userIds: string[], payload: MeetNotification): Promise<void> {
	if (!env.REALTIME) return;
	const body = JSON.stringify(payload);
	const results = await Promise.allSettled(
		[...new Set(userIds)].map((userId) =>
			env.REALTIME.getByName(userId).fetch("https://mailflare-realtime/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			}),
		),
	);
	for (const result of results) {
		if (result.status === "rejected") console.error("Meet notification failed", result.reason);
	}
}

/** Every user sharing at least one conversation with `userId` — the audience for presence updates. */
async function presenceAudience(env: CloudflareEnv, userId: string): Promise<string[]> {
	const db = getDb(env);
	const mine = await db
		.select({ conversationId: meetConversationMembers.conversationId })
		.from(meetConversationMembers)
		.where(eq(meetConversationMembers.userId, userId));
	const convIds = mine.map((row) => row.conversationId);
	if (!convIds.length) return [];
	const others = await db
		.select({ userId: meetConversationMembers.userId })
		.from(meetConversationMembers)
		.where(inArray(meetConversationMembers.conversationId, convIds));
	return [...new Set(others.map((row) => row.userId).filter((id) => id !== userId))];
}

/**
 * Called by the realtime hub when a user's socket set empties (offline) or
 * gains its first socket (online). Stamps `last_seen_at` and tells everyone
 * who shares a conversation.
 */
export async function markPresence(env: CloudflareEnv, userId: string, online: boolean): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId));
	try {
		const audience = await presenceAudience(env, userId);
		if (audience.length) {
			await notifyMeetUsers(env, audience, { type: "meet.presence", userId, online, lastSeenAt: Math.floor(now.getTime() / 1000) });
		}
	} catch (error) {
		console.error("Meet presence broadcast failed", error);
	}
}
