import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { meetMessages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { conversationMemberIds, getConversation, getMember, getMessageDto, isBlockedEitherWay } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string; messageId: string }> };

// Edits/deletes still apply, but a block in a dm silences the realtime broadcast —
// otherwise a blocked member could keep pinging the other side by editing.
async function dmIsBlocked(db: ReturnType<typeof getDb>, id: string, userId: string): Promise<boolean> {
	const conversation = await getConversation(db, id);
	if (conversation?.kind !== "dm") return false;
	const members = await conversationMemberIds(db, id);
	const other = members.find((memberId) => memberId !== userId);
	return !!other && (await isBlockedEitherWay(db, userId, other));
}

export async function PATCH(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id, messageId } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const input = (await request.json()) as { body?: string };
	const body = (input.body ?? "").trim();
	if (!body || body.length > 20_000) return NextResponse.json({ error: "Invalid message" }, { status: 400 });
	const [existing] = await db.select().from(meetMessages).where(and(eq(meetMessages.id, messageId), eq(meetMessages.conversationId, id))).limit(1);
	if (!existing || existing.deletedAt) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if (existing.senderId !== user!.id) return NextResponse.json({ error: "Only the sender can edit a message" }, { status: 403 });
	await db.update(meetMessages).set({ body, editedAt: new Date() }).where(eq(meetMessages.id, messageId));
	const message = await getMessageDto(db, messageId);
	const members = await conversationMemberIds(db, id);
	if (!(await dmIsBlocked(db, id, user!.id))) {
		await notifyMeetUsers(env, members, { type: "meet.chat", conversationId: id, message: message!, event: "edited" });
	}
	return NextResponse.json({ message });
}

export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id, messageId } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const [existing] = await db.select().from(meetMessages).where(and(eq(meetMessages.id, messageId), eq(meetMessages.conversationId, id))).limit(1);
	if (!existing || existing.deletedAt) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if (existing.senderId !== user!.id) return NextResponse.json({ error: "Only the sender can delete a message" }, { status: 403 });
	await db.update(meetMessages).set({ deletedAt: new Date() }).where(eq(meetMessages.id, messageId));
	const members = await conversationMemberIds(db, id);
	if (await dmIsBlocked(db, id, user!.id)) return NextResponse.json({ ok: true });
	await notifyMeetUsers(env, members, {
		type: "meet.chat",
		conversationId: id,
		message: { id: messageId, conversationId: id, senderId: user!.id, senderName: user!.name, type: "text", body: "", replyToId: null, replyTo: null, editedAt: null, createdAt: 0 },
		event: "deleted",
	});
	return NextResponse.json({ ok: true });
}
