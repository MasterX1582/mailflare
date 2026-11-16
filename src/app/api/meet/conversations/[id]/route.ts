import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { meetConversationMembers, meetConversations } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { conversationMemberIds, deleteConversation, getConversation, getMember, listConversations, setMemberPrefs } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const conversations = await listConversations(db, user!.id);
	const conversation = conversations.find((row) => row.id === id);
	if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	return NextResponse.json({ conversation });
}

export async function PATCH(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const member = await getMember(db, id, user!.id);
	if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const input = (await request.json()) as { name?: string; muted?: boolean; pinned?: boolean; archived?: boolean };
	// Mute/pin/archive are per-member preferences — any member may set their own.
	if (input.muted !== undefined || input.pinned !== undefined || input.archived !== undefined) {
		await setMemberPrefs(db, id, user!.id, { muted: input.muted, pinned: input.pinned, archived: input.archived });
	}
	if (input.name === undefined) return NextResponse.json({ ok: true });
	const conversation = await getConversation(db, id);
	if (!conversation || conversation.kind !== "group") return NextResponse.json({ error: "Only group conversations can be renamed" }, { status: 400 });
	if (member.role !== "owner") return NextResponse.json({ error: "Only the owner can rename this conversation" }, { status: 403 });
	const name = (input.name ?? "").trim();
	if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
	await db.update(meetConversations).set({ name, updatedAt: new Date() }).where(eq(meetConversations.id, id));
	const members = await conversationMemberIds(db, id);
	await notifyMeetUsers(env, members.filter((memberId) => memberId !== user!.id), { type: "meet.conversation", conversationId: id, event: "updated" });
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const member = await getMember(db, id, user!.id);
	if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	// ?delete=all removes the conversation for everyone — owner-only, and never for
	// a dm (the other party keeps their copy; your side is just a leave).
	if (new URL(request.url).searchParams.get("all") === "1") {
		const conversation = await getConversation(db, id);
		if (!conversation || conversation.kind === "dm" || member.role !== "owner") {
			return NextResponse.json({ error: "Only the owner can delete this conversation" }, { status: 403 });
		}
		const members = await conversationMemberIds(db, id);
		await deleteConversation(db, id);
		await notifyMeetUsers(env, members.filter((memberId) => memberId !== user!.id), { type: "meet.conversation", conversationId: id, event: "deleted" });
		return NextResponse.json({ ok: true });
	}
	await db
		.delete(meetConversationMembers)
		.where(and(eq(meetConversationMembers.conversationId, id), eq(meetConversationMembers.userId, user!.id)));
	return NextResponse.json({ ok: true });
}
