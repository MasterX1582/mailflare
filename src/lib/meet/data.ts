import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
	meetConversationMembers,
	meetConversations,
	meetMeetings,
	meetMessages,
	meetParticipants,
	meetUserBlocks,
	users,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";

type Db = ReturnType<typeof getDb>;

/** Account user ids for a list of email addresses (used to invite guests that are internal users). */
export async function userIdsForEmails(db: Db, emails: string[]): Promise<string[]> {
	if (!emails.length) return [];
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(and(inArray(sql`lower(${users.email})`, emails.map((email) => email.toLowerCase())), eq(users.disabled, false), eq(users.meetEnabled, true)));
	return rows.map((row) => row.id);
}

export function meetAccessError(user: SessionUser | null | undefined) {
	return user && !user.meetEnabled
		? { error: "Meet is disabled for this account", status: 403 as const }
		: null;
}

const toSeconds = (value: Date | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

export interface MeetMessageDto {
	id: string;
	conversationId: string;
	senderId: string;
	senderName: string;
	type: "text" | "system" | "call";
	body: string;
	replyToId: string | null;
	replyTo: { id: string; senderName: string; body: string } | null;
	editedAt: number | null;
	createdAt: number;
}

export interface MeetConversationDto {
	id: string;
	kind: "dm" | "group" | "meeting";
	name: string;
	meetingId: string | null;
	createdById: string;
	members: { userId: string; name: string; email: string; role: string; blocked: boolean }[];
	lastMessageAt: number | null;
	lastMessage: { id: string; senderName: string; body: string; createdAt: number } | null;
	unreadCount: number;
	mutedAt: number | null;
	pinnedAt: number | null;
	archivedAt: number | null;
	createdAt: number;
}

export interface MeetMeetingDto {
	id: string;
	code: string;
	ownerId: string;
	ownerName: string;
	title: string;
	kind: "instant" | "scheduled" | "dm";
	status: "scheduled" | "live" | "ended";
	calendarEventId: string | null;
	conversationId: string | null;
	scheduledStartAt: number | null;
	scheduledEndAt: number | null;
	startedAt: number | null;
	endedAt: number | null;
	createdAt: number;
	participants: { userId: string; name: string; role: string; state: string }[];
}

function toMessageDto(row: typeof meetMessages.$inferSelect, senderName: string, replyTo: MeetMessageDto["replyTo"] = null): MeetMessageDto {
	return {
		id: row.id,
		conversationId: row.conversationId,
		senderId: row.senderId,
		senderName,
		type: row.type,
		body: row.body,
		replyToId: row.replyToId,
		replyTo,
		editedAt: toSeconds(row.editedAt),
		createdAt: Math.floor(new Date(row.createdAt).getTime() / 1000),
	};
}

export async function getMember(db: Db, conversationId: string, userId: string) {
	const [row] = await db
		.select()
		.from(meetConversationMembers)
		.where(and(eq(meetConversationMembers.conversationId, conversationId), eq(meetConversationMembers.userId, userId)))
		.limit(1);
	return row ?? null;
}

export async function getConversation(db: Db, conversationId: string) {
	const [row] = await db.select().from(meetConversations).where(eq(meetConversations.id, conversationId)).limit(1);
	return row ?? null;
}

/** The dm between exactly these two users, if one exists. */
export async function findDm(db: Db, a: string, b: string) {
	const dms = await db
		.select({ conversationId: meetConversationMembers.conversationId })
		.from(meetConversationMembers)
		.innerJoin(meetConversations, eq(meetConversations.id, meetConversationMembers.conversationId))
		.where(and(eq(meetConversationMembers.userId, a), eq(meetConversations.kind, "dm")));
	for (const { conversationId } of dms) {
		const [other] = await db
			.select({ userId: meetConversationMembers.userId })
			.from(meetConversationMembers)
			.where(and(eq(meetConversationMembers.conversationId, conversationId), eq(meetConversationMembers.userId, b)))
			.limit(1);
		if (other) return getConversation(db, conversationId);
	}
	return null;
}

async function addMembers(db: Db, conversationId: string, memberIds: string[], ownerId: string) {
	const now = new Date();
	await db.insert(meetConversationMembers).values(
		[...new Set([ownerId, ...memberIds])].map((userId) => ({
			id: newId("mcm"),
			conversationId,
			userId,
			role: userId === ownerId ? ("owner" as const) : ("member" as const),
			joinedAt: now,
		})),
	);
}

export async function createConversation(
	db: Db,
	creator: SessionUser,
	input: { kind: "dm" | "group" | "meeting"; name?: string; meetingId?: string; memberIds?: string[] },
): Promise<typeof meetConversations.$inferSelect> {
	if (input.kind === "dm") {
		const other = input.memberIds?.[0];
		if (!other) throw new Error("A direct conversation needs another member");
		const existing = await findDm(db, creator.id, other);
		if (existing) return existing;
	}
	const now = new Date();
	const [conversation] = await db
		.insert(meetConversations)
		.values({
			id: newId("mco"),
			kind: input.kind,
			name: input.name ?? "",
			meetingId: input.meetingId ?? null,
			createdById: creator.id,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	await addMembers(db, conversation.id, input.memberIds ?? [], creator.id);
	return conversation;
}

async function memberNames(db: Db, conversationId: string) {
	const rows = await db
		.select({ userId: meetConversationMembers.userId, role: meetConversationMembers.role, name: users.name, email: users.email })
		.from(meetConversationMembers)
		.innerJoin(users, eq(users.id, meetConversationMembers.userId))
		.where(eq(meetConversationMembers.conversationId, conversationId));
	return rows;
}

/** Ids of everyone `userId` has blocked. */
export async function blockedUserIds(db: Db, userId: string): Promise<Set<string>> {
	const rows = await db
		.select({ blockedUserId: meetUserBlocks.blockedUserId })
		.from(meetUserBlocks)
		.where(eq(meetUserBlocks.userId, userId));
	return new Set(rows.map((row) => row.blockedUserId));
}

/** True when a block exists in either direction between the two users. */
export async function isBlockedEitherWay(db: Db, a: string, b: string): Promise<boolean> {
	const rows = await db
		.select({ id: meetUserBlocks.id })
		.from(meetUserBlocks)
		.where(
			or(
				and(eq(meetUserBlocks.userId, a), eq(meetUserBlocks.blockedUserId, b)),
				and(eq(meetUserBlocks.userId, b), eq(meetUserBlocks.blockedUserId, a)),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** The subset of `ids` that has a block in either direction with `userId`. */
export async function blockedAmong(db: Db, userId: string, ids: string[]): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const rows = await db
		.select({ userId: meetUserBlocks.userId, blockedUserId: meetUserBlocks.blockedUserId })
		.from(meetUserBlocks)
		.where(
			or(
				and(eq(meetUserBlocks.userId, userId), inArray(meetUserBlocks.blockedUserId, ids)),
				and(inArray(meetUserBlocks.userId, ids), eq(meetUserBlocks.blockedUserId, userId)),
			),
		);
	return new Set(rows.map((row) => (row.userId === userId ? row.blockedUserId : row.userId)));
}

export async function blockUser(db: Db, userId: string, blockedUserId: string) {
	await db
		.insert(meetUserBlocks)
		.values({ id: newId("mub"), userId, blockedUserId, createdAt: new Date() })
		.onConflictDoNothing();
}

export async function unblockUser(db: Db, userId: string, blockedUserId: string) {
	await db
		.delete(meetUserBlocks)
		.where(and(eq(meetUserBlocks.userId, userId), eq(meetUserBlocks.blockedUserId, blockedUserId)));
}

export async function listBlockedUsers(db: Db, userId: string) {
	return db
		.select({ userId: meetUserBlocks.blockedUserId, name: users.name, email: users.email, createdAt: meetUserBlocks.createdAt })
		.from(meetUserBlocks)
		.innerJoin(users, eq(users.id, meetUserBlocks.blockedUserId))
		.where(eq(meetUserBlocks.userId, userId));
}

/** Per-member conversation preferences (mute / pin / archive), owned by the member row. */
export async function setMemberPrefs(
	db: Db,
	conversationId: string,
	userId: string,
	prefs: { muted?: boolean; pinned?: boolean; archived?: boolean },
) {
	const patch: Partial<typeof meetConversationMembers.$inferInsert> = {};
	if (prefs.muted !== undefined) patch.mutedAt = prefs.muted ? new Date() : null;
	if (prefs.pinned !== undefined) patch.pinnedAt = prefs.pinned ? new Date() : null;
	if (prefs.archived !== undefined) patch.archivedAt = prefs.archived ? new Date() : null;
	if (!Object.keys(patch).length) return;
	await db
		.update(meetConversationMembers)
		.set(patch)
		.where(and(eq(meetConversationMembers.conversationId, conversationId), eq(meetConversationMembers.userId, userId)));
}

export async function listConversations(db: Db, userId: string): Promise<MeetConversationDto[]> {
	const memberships = await db
		.select({
			conversationId: meetConversationMembers.conversationId,
			lastReadAt: meetConversationMembers.lastReadAt,
			mutedAt: meetConversationMembers.mutedAt,
			pinnedAt: meetConversationMembers.pinnedAt,
			archivedAt: meetConversationMembers.archivedAt,
		})
		.from(meetConversationMembers)
		.where(eq(meetConversationMembers.userId, userId));
	if (!memberships.length) return [];
	const convIds = memberships.map((row) => row.conversationId);
	const memberState = new Map(memberships.map((row) => [row.conversationId, row]));
	const blocked = await blockedUserIds(db, userId);
	const conversations = await db.select().from(meetConversations).where(inArray(meetConversations.id, convIds));

	const result: MeetConversationDto[] = [];
	for (const conversation of conversations) {
		const members = await memberNames(db, conversation.id);
		const [last] = await db
			.select({ id: meetMessages.id, body: meetMessages.body, createdAt: meetMessages.createdAt, senderName: users.name })
			.from(meetMessages)
			.innerJoin(users, eq(users.id, meetMessages.senderId))
			.where(and(eq(meetMessages.conversationId, conversation.id), isNull(meetMessages.deletedAt)))
			.orderBy(desc(meetMessages.createdAt))
			.limit(1);
		const state = memberState.get(conversation.id);
		const readAt = state?.lastReadAt;
		const [unread] = await db
			.select({ count: sql<number>`count(*)` })
			.from(meetMessages)
			.where(
				and(
					eq(meetMessages.conversationId, conversation.id),
					ne(meetMessages.senderId, userId),
					isNull(meetMessages.deletedAt),
					readAt ? gt(meetMessages.createdAt, readAt) : undefined,
				),
			);
		result.push({
			id: conversation.id,
			kind: conversation.kind,
			name: conversation.name,
			meetingId: conversation.meetingId,
			createdById: conversation.createdById,
			members: members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, blocked: blocked.has(m.userId) })),
			lastMessageAt: toSeconds(conversation.lastMessageAt),
			lastMessage: last ? { id: last.id, senderName: last.senderName, body: last.body, createdAt: Math.floor(new Date(last.createdAt).getTime() / 1000) } : null,
			unreadCount: Number(unread?.count ?? 0),
			mutedAt: toSeconds(state?.mutedAt),
			pinnedAt: toSeconds(state?.pinnedAt),
			archivedAt: toSeconds(state?.archivedAt),
			createdAt: Math.floor(new Date(conversation.createdAt).getTime() / 1000),
		});
	}
	result.sort((a, b) => {
		if ((a.pinnedAt != null) !== (b.pinnedAt != null)) return a.pinnedAt != null ? -1 : 1;
		return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt);
	});
	return result;
}

export async function listMessages(
	db: Db,
	conversationId: string,
	{ before, limit = 50 }: { before?: number; limit?: number },
): Promise<MeetMessageDto[]> {
	const rows = await db
		.select({ message: meetMessages, senderName: users.name })
		.from(meetMessages)
		.innerJoin(users, eq(users.id, meetMessages.senderId))
		.where(
			and(
				eq(meetMessages.conversationId, conversationId),
				isNull(meetMessages.deletedAt),
				before ? lt(meetMessages.createdAt, new Date(before * 1000)) : undefined,
			),
		)
		.orderBy(desc(meetMessages.createdAt))
		.limit(limit);
	const replyIds = [...new Set(rows.map((row) => row.message.replyToId).filter((id): id is string => !!id))];
	const replies = replyIds.length
		? await db
				.select({ id: meetMessages.id, body: meetMessages.body, senderName: users.name })
				.from(meetMessages)
				.innerJoin(users, eq(users.id, meetMessages.senderId))
				.where(and(inArray(meetMessages.id, replyIds), eq(meetMessages.conversationId, conversationId), isNull(meetMessages.deletedAt)))
		: [];
	const replyMap = new Map(replies.map((row) => [row.id, { id: row.id, senderName: row.senderName, body: row.body }]));
	return rows.map((row) => toMessageDto(row.message, row.senderName, row.message.replyToId ? replyMap.get(row.message.replyToId) ?? null : null)).reverse();
}

export async function getMessageDto(db: Db, messageId: string): Promise<MeetMessageDto | null> {
	const [row] = await db
		.select({ message: meetMessages, senderName: users.name })
		.from(meetMessages)
		.innerJoin(users, eq(users.id, meetMessages.senderId))
		.where(eq(meetMessages.id, messageId))
		.limit(1);
	if (!row || row.message.deletedAt) return null;
	let replyTo: MeetMessageDto["replyTo"] = null;
	if (row.message.replyToId) {
		const [reply] = await db
			.select({ id: meetMessages.id, body: meetMessages.body, senderName: users.name })
			.from(meetMessages)
			.innerJoin(users, eq(users.id, meetMessages.senderId))
			.where(and(eq(meetMessages.id, row.message.replyToId), eq(meetMessages.conversationId, row.message.conversationId), isNull(meetMessages.deletedAt)))
			.limit(1);
		if (reply) replyTo = reply;
	}
	return toMessageDto(row.message, row.senderName, replyTo);
}

export async function createMessage(
	db: Db,
	input: { conversationId: string; senderId: string; body: string; type?: "text" | "system" | "call"; replyToId?: string | null },
) {
	const now = new Date();
	const [row] = await db
		.insert(meetMessages)
		.values({
			id: newId("mms"),
			conversationId: input.conversationId,
			senderId: input.senderId,
			type: input.type ?? "text",
			body: input.body,
			replyToId: input.replyToId ?? null,
			createdAt: now,
		})
		.returning();
	await db.update(meetConversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(meetConversations.id, input.conversationId));
	// A new message unarchives the conversation for everyone who still has it hidden.
	await db
		.update(meetConversationMembers)
		.set({ archivedAt: null })
		.where(and(eq(meetConversationMembers.conversationId, input.conversationId), isNotNull(meetConversationMembers.archivedAt)));
	return row;
}

/** Hard-delete a conversation and everything hanging off it. Owner-only callers. */
export async function deleteConversation(db: Db, conversationId: string) {
	await db.delete(meetMessages).where(eq(meetMessages.conversationId, conversationId));
	await db.delete(meetConversationMembers).where(eq(meetConversationMembers.conversationId, conversationId));
	await db.update(meetMeetings).set({ conversationId: null }).where(eq(meetMeetings.conversationId, conversationId));
	await db.delete(meetConversations).where(eq(meetConversations.id, conversationId));
}

export async function conversationMemberIds(db: Db, conversationId: string): Promise<string[]> {
	const rows = await db
		.select({ userId: meetConversationMembers.userId })
		.from(meetConversationMembers)
		.where(eq(meetConversationMembers.conversationId, conversationId));
	return rows.map((row) => row.userId);
}

/** Heartbeat: refresh `last_seen_at` without a presence broadcast. */
export async function touchLastSeen(env: CloudflareEnv, userId: string): Promise<void> {
	await getDb(env).update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}

const MEETING_CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newMeetingCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return [...bytes].map((byte) => MEETING_CODE_ALPHABET[byte % MEETING_CODE_ALPHABET.length]).join("");
}

export function toMeetingDto(
	meeting: typeof meetMeetings.$inferSelect,
	ownerName: string,
	participants: { userId: string; name: string; role: string; state: string }[],
): MeetMeetingDto {
	return {
		id: meeting.id,
		code: meeting.code,
		ownerId: meeting.ownerId,
		ownerName,
		title: meeting.title,
		kind: meeting.kind,
		status: meeting.status,
		calendarEventId: meeting.calendarEventId,
		conversationId: meeting.conversationId,
		scheduledStartAt: toSeconds(meeting.scheduledStartAt),
		scheduledEndAt: toSeconds(meeting.scheduledEndAt),
		startedAt: toSeconds(meeting.startedAt),
		endedAt: toSeconds(meeting.endedAt),
		createdAt: Math.floor(new Date(meeting.createdAt).getTime() / 1000),
		participants,
	};
}

export async function getMeetingDto(db: Db, meetingId: string): Promise<MeetMeetingDto | null> {
	const [meeting] = await db.select().from(meetMeetings).where(eq(meetMeetings.id, meetingId)).limit(1);
	if (!meeting) return null;
	const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, meeting.ownerId)).limit(1);
	const participants = await db
		.select({ userId: meetParticipants.userId, role: meetParticipants.role, state: meetParticipants.state, name: users.name })
		.from(meetParticipants)
		.innerJoin(users, eq(users.id, meetParticipants.userId))
		.where(eq(meetParticipants.meetingId, meetingId));
	return toMeetingDto(meeting, owner?.name ?? "", participants);
}

export async function getMeeting(db: Db, meetingId: string) {
	const [meeting] = await db.select().from(meetMeetings).where(eq(meetMeetings.id, meetingId)).limit(1);
	return meeting ?? null;
}

export async function getMeetingByCode(db: Db, code: string) {
	const [meeting] = await db.select().from(meetMeetings).where(eq(meetMeetings.code, code)).limit(1);
	return meeting ?? null;
}

export async function getParticipant(db: Db, meetingId: string, userId: string) {
	const [row] = await db
		.select()
		.from(meetParticipants)
		.where(and(eq(meetParticipants.meetingId, meetingId), eq(meetParticipants.userId, userId)))
		.limit(1);
	return row ?? null;
}

export async function createMeeting(
	db: Db,
	owner: SessionUser,
	input: {
		title?: string;
		kind?: "instant" | "scheduled" | "dm";
		calendarEventId?: string | null;
		scheduledStartAt?: Date | null;
		scheduledEndAt?: Date | null;
		participantIds?: string[];
		withConversation?: boolean;
	},
) {
	const now = new Date();
	let conversationId: string | null = null;
	// Only stamp conversation.meetingId when the conversation was created for this
	// meeting — a reused dm must not point at whichever call ran last.
	let ownsConversation = false;
	if (input.withConversation !== false) {
		if (input.kind === "dm") {
			// 1:1 calls live inside the pair's dm — a call must not spawn a separate
			// "meeting" chat for the same two people.
			const other = (input.participantIds ?? []).find((id) => id !== owner.id) ?? null;
			const dm = other ? await findDm(db, owner.id, other) : null;
			if (dm) {
				conversationId = dm.id;
			} else {
				const conversation = await createConversation(db, owner, { kind: "dm", name: "", memberIds: other ? [other] : [] });
				conversationId = conversation.id;
				ownsConversation = true;
			}
		} else {
			const conversation = await createConversation(db, owner, { kind: "meeting", name: input.title ?? "", memberIds: input.participantIds ?? [] });
			conversationId = conversation.id;
			ownsConversation = true;
		}
	}
	const id = newId("mmt");
	const [meeting] = await db
		.insert(meetMeetings)
		.values({
			id,
			code: newMeetingCode(),
			ownerId: owner.id,
			title: input.title ?? "",
			kind: input.kind ?? "instant",
			status: "scheduled",
			calendarEventId: input.calendarEventId ?? null,
			conversationId,
			scheduledStartAt: input.scheduledStartAt ?? null,
			scheduledEndAt: input.scheduledEndAt ?? null,
			createdAt: now,
		})
		.returning();
	if (conversationId && ownsConversation) {
		await db.update(meetConversations).set({ meetingId: id }).where(eq(meetConversations.id, conversationId));
	}
	await db.insert(meetParticipants).values(
		[...new Set([owner.id, ...(input.participantIds ?? [])])].map((userId) => ({
			id: newId("mpt"),
			meetingId: id,
			userId,
			role: userId === owner.id ? ("host" as const) : ("participant" as const),
			state: "invited" as const,
			invitedAt: now,
		})),
	);
	return meeting;
}

/** Calendar events owned by `userId` that carry a Meet call, for the Meetings tab's upcoming list. */
export async function listUpcomingMeetings(db: Db, userId: string) {
	const participations = await db
		.select({ meetingId: meetParticipants.meetingId })
		.from(meetParticipants)
		.where(eq(meetParticipants.userId, userId));
	const ids = participations.map((row) => row.meetingId);
	if (!ids.length) return [];
	const meetings = await db
		.select({ meeting: meetMeetings, ownerName: users.name })
		.from(meetMeetings)
		.innerJoin(users, eq(users.id, meetMeetings.ownerId))
		.where(and(inArray(meetMeetings.id, ids), ne(meetMeetings.status, "ended")))
		.orderBy(desc(meetMeetings.createdAt))
		.limit(50);
	const result: MeetMeetingDto[] = [];
	for (const { meeting, ownerName } of meetings) {
		const participants = await db
			.select({ userId: meetParticipants.userId, role: meetParticipants.role, state: meetParticipants.state, name: users.name })
			.from(meetParticipants)
			.innerJoin(users, eq(users.id, meetParticipants.userId))
			.where(eq(meetParticipants.meetingId, meeting.id));
		result.push(toMeetingDto(meeting, ownerName, participants));
	}
	return result;
}

export async function iceServers(env: CloudflareEnv): Promise<{ urls: string | string[]; username?: string; credential?: string }[]> {
	const servers: { urls: string | string[]; username?: string; credential?: string }[] = [];
	const stun = (env as unknown as Record<string, string | undefined>).WEBRTC_STUN_URLS;
	if (stun) servers.push({ urls: stun.split(",").map((url) => url.trim()).filter(Boolean) });
	const turnUrls = (env as unknown as Record<string, string | undefined>).WEBRTC_TURN_URLS;
	if (turnUrls) {
		servers.push({
			urls: turnUrls.split(",").map((url) => url.trim()).filter(Boolean),
			username: (env as unknown as Record<string, string | undefined>).WEBRTC_TURN_USERNAME,
			credential: (env as unknown as Record<string, string | undefined>).WEBRTC_TURN_CREDENTIAL,
		});
	}
	if (!servers.length) servers.push({ urls: "stun:stun.l.google.com:19302" });
	return servers;
}
