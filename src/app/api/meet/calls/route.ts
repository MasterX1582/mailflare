import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { meetCalls, meetParticipants, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { createMeeting, getMeetingDto, getParticipant, isBlockedEitherWay } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

/** 1:1 calls are dm meetings; this endpoint dials another user and rings them. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { to?: string; mediaKind?: string };
	if (typeof input.to !== "string" || !input.to || input.to === user!.id) {
		return NextResponse.json({ error: "Choose someone to call" }, { status: 400 });
	}
	const db = getDb(env);
	const [callee] = await db
		.select({ id: users.id, name: users.name })
		.from(users)
		.where(and(eq(users.id, input.to), eq(users.disabled, false), eq(users.meetEnabled, true)))
		.limit(1);
	if (!callee) return NextResponse.json({ error: "User not found" }, { status: 404 });
	if (await isBlockedEitherWay(db, user!.id, callee.id)) {
		return NextResponse.json({ error: "Cannot call this user" }, { status: 403 });
	}

	// One open ringing call per caller→callee pair; redials return the existing call.
	const [ringing] = await db
		.select({ id: meetCalls.id })
		.from(meetCalls)
		.innerJoin(meetParticipants, eq(meetParticipants.meetingId, meetCalls.meetingId))
		.where(and(eq(meetCalls.initiatorId, user!.id), eq(meetParticipants.userId, callee.id), isNull(meetCalls.answeredAt), isNull(meetCalls.endedAt)))
		.limit(1);
	if (ringing) return NextResponse.json({ error: "A call to this user is already ringing" }, { status: 429 });
	const openCalls = await db.select({ id: meetCalls.id }).from(meetCalls).where(and(eq(meetCalls.initiatorId, user!.id), isNull(meetCalls.endedAt)));
	if (openCalls.length >= 10) return NextResponse.json({ error: "Too many open calls" }, { status: 429 });

	const meeting = await createMeeting(db, user!, {
		title: `${user!.name} & ${callee.name}`,
		kind: "dm",
		participantIds: [callee.id],
	});
	const [call] = await db
		.insert(meetCalls)
		.values({ id: newId("mcl"), meetingId: meeting.id, initiatorId: user!.id, mediaKind: input.mediaKind === "audio" ? "audio" : "video", startedAt: new Date() })
		.returning();

	await notifyMeetUsers(env, [callee.id], {
		type: "meet.call",
		callId: call.id,
		meetingId: meeting.id,
		action: "ringing",
		from: { id: user!.id, name: user!.name },
		mediaKind: call.mediaKind,
		title: user!.name,
	});

	const dto = await getMeetingDto(db, meeting.id);
	return NextResponse.json({ call: { id: call.id }, meeting: dto }, { status: 201 });
}

/** Cancel a ringing call, or mark one declined/ended. */
export async function PATCH(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { callId?: string; action?: string; to?: string };
	const action = input.action === "declined" ? "declined" : input.action === "ended" ? "ended" : "cancelled";
	const db = getDb(env);
	const [call] = await db.select().from(meetCalls).where(and(eq(meetCalls.id, input.callId ?? ""), isNull(meetCalls.endedAt))).limit(1);
	if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });
	// Only a party to the call (the initiator or another meeting participant) may transition it.
	const isInitiator = call.initiatorId === user!.id;
	const participant = isInitiator ? null : await getParticipant(db, call.meetingId, user!.id);
	if (!isInitiator && !participant) return NextResponse.json({ error: "Call not found" }, { status: 404 });
	// "ended" marks an answered call complete — only a joined party can do that;
	// "declined" is for invitees still ringing; the initiator may always cancel.
	if (!isInitiator) {
		const state = participant!.state;
		if (action === "ended" && state !== "joined") return NextResponse.json({ error: "Call not found" }, { status: 404 });
		if (action === "declined" && state !== "invited") return NextResponse.json({ error: "Call not found" }, { status: 404 });
	}
	const now = new Date();
	await db
		.update(meetCalls)
		.set({ endedAt: now, endReason: action === "ended" ? "completed" : action })
		.where(eq(meetCalls.id, call.id));
	// Notify the call's real counterpart(s), never a client-supplied recipient.
	const others = (
		await db.select({ userId: meetParticipants.userId }).from(meetParticipants).where(eq(meetParticipants.meetingId, call.meetingId))
	)
		.map((row) => row.userId)
		.filter((id) => id !== user!.id);
	if (others.length) {
		await notifyMeetUsers(env, others, {
			type: "meet.call",
			callId: call.id,
			meetingId: call.meetingId,
			action: action === "ended" ? "ended" : isInitiator ? "cancelled" : "declined",
			from: { id: user!.id, name: user!.name },
			mediaKind: call.mediaKind,
			title: "",
		});
	}
	return NextResponse.json({ ok: true });
}
