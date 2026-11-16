import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeetingDto, getParticipant } from "@/lib/meet/data";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const meeting = await getMeetingDto(db, id);
	if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
	const participant = await getParticipant(db, id, user!.id);
	if (!participant) {
		// Non-participants get a join-preview only — no roster, join code, or internal linkage ids.
		const { participants: _p, code: _c, conversationId: _cv, calendarEventId: _ce, ownerId: _o, ...preview } = meeting;
		return NextResponse.json({ meeting: preview, invited: false });
	}
	return NextResponse.json({ meeting, invited: true });
}
