import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetCalls, meetMeetings, meetParticipants } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeeting } from "@/lib/meet/data";
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
	if (meeting.ownerId !== user!.id) return NextResponse.json({ error: "Only the host can end this meeting" }, { status: 403 });

	const now = new Date();
	await db.update(meetMeetings).set({ status: "ended", endedAt: now }).where(eq(meetMeetings.id, id));
	await db
		.update(meetParticipants)
		.set({ state: "left", leftAt: now })
		.where(and(eq(meetParticipants.meetingId, id), eq(meetParticipants.state, "joined")));
	await db.update(meetCalls).set({ endedAt: now, endReason: "completed" }).where(and(eq(meetCalls.meetingId, id), isNull(meetCalls.endedAt)));

	const participants = await db.select({ userId: meetParticipants.userId }).from(meetParticipants).where(eq(meetParticipants.meetingId, id));
	await notifyMeetUsers(
		env,
		participants.map((row) => row.userId).filter((userId) => userId !== user!.id),
		{ type: "meet.room", meetingId: id, event: "ended", userId: user!.id },
	);
	return NextResponse.json({ ok: true });
}
