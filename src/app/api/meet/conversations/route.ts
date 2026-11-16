import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { blockedAmong, conversationMemberIds, createConversation, findDm, getConversation, listConversations } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const conversations = await listConversations(getDb(env), user!.id);
	return NextResponse.json({ conversations });
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { kind?: string; name?: string; memberIds?: string[] };
	const kind = input.kind === "dm" ? "dm" : "group";
	const memberIds = [...new Set((input.memberIds ?? []).filter((id): id is string => typeof id === "string" && id !== user!.id))];
	if (kind === "dm" && memberIds.length !== 1) return NextResponse.json({ error: "A direct conversation needs exactly one other member" }, { status: 400 });
	if (kind === "group" && !memberIds.length) return NextResponse.json({ error: "Choose at least one member" }, { status: 400 });
	if (memberIds.length > 50) return NextResponse.json({ error: "Too many members" }, { status: 400 });
	if (memberIds.length) {
		const db = getDb(env);
		const found = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, memberIds), eq(users.disabled, false), eq(users.meetEnabled, true)));
		if (found.length !== memberIds.length) return NextResponse.json({ error: "Unknown member" }, { status: 400 });
	}
	const db = getDb(env);
	const blocked = await blockedAmong(db, user!.id, memberIds);
	if (kind === "dm" && blocked.size) {
		return NextResponse.json({ error: "Cannot start this conversation" }, { status: 403 });
	}
	// A group cannot smuggle in someone with a block either way — that would just
	// be a dm under a different kind and bypass the messaging block.
	const memberIdsAllowed = kind === "group" ? memberIds.filter((id) => !blocked.has(id)) : memberIds;
	if (kind === "group" && !memberIdsAllowed.length) return NextResponse.json({ error: "Choose at least one member" }, { status: 400 });
	const preexisting = kind === "dm" ? await findDm(db, user!.id, memberIds[0]) : null;
	const conversation = await createConversation(db, user!, {
		kind,
		name: kind === "group" ? (input.name ?? "").trim() : "",
		memberIds: memberIdsAllowed,
	});
	if (!preexisting) {
		const members = await conversationMemberIds(db, conversation.id);
		await notifyMeetUsers(env, members.filter((id) => id !== user!.id), {
			type: "meet.conversation",
			conversationId: conversation.id,
			event: "created",
		});
	}
	const conversations = await listConversations(db, user!.id);
	const created = conversations.find((row) => row.id === conversation.id) ?? null;
	return NextResponse.json({ conversation: created ?? { ...(await getConversation(db, conversation.id)), members: [], lastMessageAt: null, lastMessage: null, unreadCount: 0 } }, { status: 201 });
}
