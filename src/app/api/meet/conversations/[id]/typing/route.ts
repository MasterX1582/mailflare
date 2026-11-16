import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { conversationMemberIds, getConversation, getMember, isBlockedEitherWay } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	if (!(await getMember(db, id, user!.id))) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	const input = (await request.json()) as { isTyping?: boolean };
	const members = await conversationMemberIds(db, id);
	// A blocked dm keeps the typing channel closed too.
	const conversation = await getConversation(db, id);
	if (conversation?.kind === "dm") {
		const other = members.find((memberId) => memberId !== user!.id);
		if (other && (await isBlockedEitherWay(db, user!.id, other))) {
			return NextResponse.json({ error: "Cannot send in this conversation" }, { status: 403 });
		}
	}
	await notifyMeetUsers(
		env,
		members.filter((memberId) => memberId !== user!.id),
		{ type: "meet.typing", conversationId: id, userId: user!.id, name: user!.name, isTyping: !!input.isTyping },
	);
	return NextResponse.json({ ok: true });
}
