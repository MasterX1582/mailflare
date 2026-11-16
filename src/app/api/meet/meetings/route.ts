import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetCalls, meetMeetings, meetParticipants, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { blockedAmong, createMeeting, getMeetingDto, listUpcomingMeetings } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const db = getDb(env);
	const meetings = await listUpcomingMeetings(db, user!.id);
	// Recent calls involving this user, for the history list.
	const participations = await db
		.select({ meetingId: meetParticipants.meetingId })
		.from(meetParticipants)
		.where(eq(meetParticipants.userId, user!.id));
	const meetingIds = participations.map((row) => row.meetingId);
	const calls = meetingIds.length
		? await db
				.select({ call: meetCalls, initiatorName: users.name, meetingTitle: meetMeetings.title })
				.from(meetCalls)
				.innerJoin(users, eq(users.id, meetCalls.initiatorId))
				.innerJoin(meetMeetings, eq(meetMeetings.id, meetCalls.meetingId))
				.where(inArray(meetCalls.meetingId, meetingIds))
				.orderBy(desc(meetCalls.startedAt))
				.limit(30)
		: [];
	return NextResponse.json({
		meetings,
		calls: calls.map(({ call, initiatorName, meetingTitle }) => ({
			id: call.id,
			meetingId: call.meetingId,
			initiatorId: call.initiatorId,
			initiatorName,
			meetingTitle,
			mediaKind: call.mediaKind,
			endReason: call.endReason,
			startedAt: Math.floor(new Date(call.startedAt).getTime() / 1000),
			answeredAt: call.answeredAt ? Math.floor(new Date(call.answeredAt).getTime() / 1000) : null,
			endedAt: call.endedAt ? Math.floor(new Date(call.endedAt).getTime() / 1000) : null,
		})),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as {
		title?: string;
		kind?: string;
		calendarEventId?: string;
		scheduledStartAt?: number;
		scheduledEndAt?: number;
		participantIds?: string[];
		mediaKind?: string;
	};
	const kind = input.kind === "scheduled" ? "scheduled" : "instant";
	const requestedIds = [...new Set((input.participantIds ?? []).filter((id): id is string => typeof id === "string" && id !== user!.id))].slice(0, 50);
	const db = getDb(env);
	// Only eligible accounts may be invited, exactly like the call callee check.
	const eligible = requestedIds.length
		? await db.select({ id: users.id }).from(users).where(and(inArray(users.id, requestedIds), eq(users.disabled, false), eq(users.meetEnabled, true)))
		: [];
	// Accounts with a block in either direction are dropped like ineligible ones —
	// an "instant" meeting rings its invitees, which would bypass the call block.
	const blocked = await blockedAmong(db, user!.id, requestedIds);
	const participantIds = eligible.map((row) => row.id).filter((id) => !blocked.has(id));
	if (kind === "instant" && participantIds.length) {
		const openCalls = await db.select({ id: meetCalls.id }).from(meetCalls).where(and(eq(meetCalls.initiatorId, user!.id), isNull(meetCalls.endedAt)));
		if (openCalls.length >= 10) return NextResponse.json({ error: "Too many open calls" }, { status: 429 });
	}
	const meeting = await createMeeting(db, user!, {
		title: (input.title ?? "").trim(),
		kind,
		calendarEventId: input.calendarEventId ?? null,
		scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt * 1000) : null,
		scheduledEndAt: input.scheduledEndAt ? new Date(input.scheduledEndAt * 1000) : null,
		participantIds,
	});
	// An instant meeting with invitees rings them like a call.
	if (kind === "instant" && participantIds.length) {
		const [call] = await db
			.insert(meetCalls)
			.values({ id: newId("mcl"), meetingId: meeting.id, initiatorId: user!.id, mediaKind: input.mediaKind === "audio" ? "audio" : "video", startedAt: new Date() })
			.returning();
		await notifyMeetUsers(env, participantIds, {
			type: "meet.call",
			callId: call.id,
			meetingId: meeting.id,
			action: "ringing",
			from: { id: user!.id, name: user!.name },
			mediaKind: call.mediaKind,
			title: meeting.title || `${user!.name}'s meeting`,
		});
	}
	const dto = await getMeetingDto(db, meeting.id);
	return NextResponse.json({ meeting: dto }, { status: 201 });
}
