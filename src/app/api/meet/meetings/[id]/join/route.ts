import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetCalls, meetMeetings, meetParticipants } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeeting, getMeetingDto, getParticipant, iceServers } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

/**
 * Joining creates (or reactivates) the participant row. Only users holding a
 * participant row are ever reached by the signaling relay — the same
 * authorization boundary VideoChatPro enforced on `join-room`.
 */
export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const meeting = await getMeeting(db, id);
	if (!meeting || meeting.status === "ended") return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

	const now = new Date();
	const existing = await getParticipant(db, id, user!.id);
	if (!existing) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
	if (existing.state !== "joined") {
		await db.update(meetParticipants).set({ state: "joined", joinedAt: now, leftAt: null }).where(eq(meetParticipants.id, existing.id));
	} else {
		const dto = await getMeetingDto(db, id);
		return NextResponse.json({ meeting: dto, iceServers: await iceServers(env) });
	}

	if (meeting.status === "scheduled") {
		await db.update(meetMeetings).set({ status: "live", startedAt: meeting.startedAt ?? now }).where(eq(meetMeetings.id, id));
	}

	// A joined room is an answered call for history purposes.
	await db
		.update(meetCalls)
		.set({ answeredAt: now })
		.where(and(eq(meetCalls.meetingId, id), isNull(meetCalls.answeredAt)));

	const others = await db
		.select({ userId: meetParticipants.userId })
		.from(meetParticipants)
		.where(and(eq(meetParticipants.meetingId, id), eq(meetParticipants.state, "joined")));
	await notifyMeetUsers(
		env,
		others.map((row) => row.userId).filter((userId) => userId !== user!.id),
		{ type: "meet.room", meetingId: id, event: "peer-joined", userId: user!.id, name: user!.name },
	);

	const dto = await getMeetingDto(db, id);
	return NextResponse.json({ meeting: dto, iceServers: await iceServers(env) });
}
