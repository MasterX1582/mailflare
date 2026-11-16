import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { meetParticipants } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeetingByCode, getMeetingDto, getParticipant } from "@/lib/meet/data";

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { code?: string };
	const code = (input.code ?? "").trim().toLowerCase();
	if (!code) return NextResponse.json({ error: "Meeting code is required" }, { status: 400 });
	const db = getDb(env);
	const meeting = await getMeetingByCode(db, code);
	if (!meeting || meeting.status === "ended") return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

	const existing = await getParticipant(db, meeting.id, user!.id);
	if (!existing) {
		// 1:1 call rooms are invite-only — a code alone never admits outsiders.
		if (meeting.kind === "dm") return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
		// A valid code issues an invite; the join route still performs the actual join.
		const now = new Date();
		await db
			.insert(meetParticipants)
			.values({ id: newId("mpt"), meetingId: meeting.id, userId: user!.id, role: "participant", state: "invited", invitedAt: now })
			.onConflictDoNothing({ target: [meetParticipants.meetingId, meetParticipants.userId] });
	}

	const dto = await getMeetingDto(db, meeting.id);
	return NextResponse.json({ meeting: dto });
}
