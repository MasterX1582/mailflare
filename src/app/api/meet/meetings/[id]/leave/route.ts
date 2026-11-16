import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetCalls, meetMeetings, meetParticipants } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeeting, getParticipant } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const meeting = await getMeeting(db, id);
	if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
	const participant = await getParticipant(db, id, user!.id);
	if (!participant) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

	const now = new Date();
	if (participant.state !== "joined") return NextResponse.json({ ok: true });
	await db.update(meetParticipants).set({ state: "left", leftAt: now }).where(eq(meetParticipants.id, participant.id));

	const remaining = await db
		.select({ userId: meetParticipants.userId })
		.from(meetParticipants)
		.where(and(eq(meetParticipants.meetingId, id), eq(meetParticipants.state, "joined")));
	await notifyMeetUsers(env, remaining.map((row) => row.userId), { type: "meet.room", meetingId: id, event: "peer-left", userId: user!.id, name: user!.name });

	// Instant/dm rooms end once the last participant leaves; scheduled meetings
	// end only via the explicit end route so a stray leave can't sabotage them.
	if (meeting.status === "live" && meeting.kind !== "scheduled" && remaining.length === 0) {
		await db.update(meetMeetings).set({ status: "ended", endedAt: now }).where(eq(meetMeetings.id, id));
		await db
			.update(meetCalls)
			.set({ endedAt: now, endReason: "completed" })
			.where(and(eq(meetCalls.meetingId, id), isNull(meetCalls.endedAt)));
	}
	return NextResponse.json({ ok: true });
}
