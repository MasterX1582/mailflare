import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetMessages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { conversationMemberIds, createMessage, getConversation, getMember, getMessageDto, isBlockedEitherWay, listMessages } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const url = new URL(request.url);
	const before = Number(url.searchParams.get("before"));
	const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 100));
	const messages = await listMessages(db, id, { before: Number.isFinite(before) && before > 0 ? before : undefined, limit });
	return NextResponse.json({ messages });
}

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const input = (await request.json()) as { body?: string; replyToId?: string };
	const body = (input.body ?? "").trim();
	if (!body) return NextResponse.json({ error: "Message is required" }, { status: 400 });
	if (body.length > 20_000) return NextResponse.json({ error: "Message is too long" }, { status: 400 });
	// In a dm a block in either direction silences the thread.
	const conversation = await getConversation(db, id);
	if (conversation?.kind === "dm") {
		const members = await conversationMemberIds(db, id);
		const other = members.find((memberId) => memberId !== user!.id);
		if (other && (await isBlockedEitherWay(db, user!.id, other))) {
			return NextResponse.json({ error: "Cannot send messages in this conversation" }, { status: 403 });
		}
	}
	let replyToId: string | null = null;
	if (input.replyToId) {
		const [reply] = await db
			.select({ id: meetMessages.id })
			.from(meetMessages)
			.where(and(eq(meetMessages.id, input.replyToId), eq(meetMessages.conversationId, id), isNull(meetMessages.deletedAt)))
			.limit(1);
		replyToId = reply?.id ?? null;
	}
	const row = await createMessage(db, { conversationId: id, senderId: user!.id, body, replyToId });
	const message = await getMessageDto(db, row.id);
	const members = await conversationMemberIds(db, id);
	await notifyMeetUsers(env, members, { type: "meet.chat", conversationId: id, message: message!, event: "created" });
	return NextResponse.json({ message }, { status: 201 });
}
