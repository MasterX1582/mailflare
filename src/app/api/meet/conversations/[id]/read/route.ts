import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { meetConversationMembers } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMember } from "@/lib/meet/data";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const input = (await request.json().catch(() => ({}))) as { messageId?: string };
	await db
		.update(meetConversationMembers)
		.set({ lastReadAt: new Date(), lastReadMessageId: input.messageId ?? null })
		.where(and(eq(meetConversationMembers.conversationId, id), eq(meetConversationMembers.userId, user!.id)));
	return NextResponse.json({ ok: true });
}
