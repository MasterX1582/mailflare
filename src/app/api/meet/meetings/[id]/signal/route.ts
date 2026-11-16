import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { getMeeting, getParticipant } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

type Params = { params: Promise<{ id: string }> };

const MAX_SIGNAL_BYTES = 64 * 1024;

/**
 * WebRTC signaling relay. Both ends must hold a `joined` participant row —
 * mirrors VideoChatPro's rule that signals never reach a user who was not
 * admitted to the room first.
 */
export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const { id } = await params;
	const db = getDb(env);
	const meeting = await getMeeting(db, id);
	if (!meeting || meeting.status === "ended") return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
	const sender = await getParticipant(db, id, user!.id);
	if (!sender || sender.state !== "joined") return NextResponse.json({ error: "Join the meeting first" }, { status: 403 });

	const raw = await request.text();
	if (raw.length > MAX_SIGNAL_BYTES) return NextResponse.json({ error: "Signal too large" }, { status: 413 });
	let input: { to?: string; payload?: unknown };
	try {
		input = JSON.parse(raw) as { to?: string; payload?: unknown };
	} catch {
		return NextResponse.json({ error: "Invalid signal" }, { status: 400 });
	}
	if (typeof input.to !== "string" || !input.to) return NextResponse.json({ error: "Missing target" }, { status: 400 });
	const p = input.payload as Record<string, unknown> | null;
	const shapeOk = p === null || p === undefined
		|| (typeof p.description === "object" && p.description !== null && typeof (p.description as Record<string, unknown>).sdp === "string" && typeof (p.description as Record<string, unknown>).type === "string")
		|| (typeof p.candidate === "object" && p.candidate !== null && typeof (p.candidate as Record<string, unknown>).candidate === "string");
	if (!shapeOk) return NextResponse.json({ error: "Invalid signal payload" }, { status: 400 });

	const target = await getParticipant(db, id, input.to);
	if (!target || target.state !== "joined") return NextResponse.json({ error: "Target is not in this meeting" }, { status: 403 });

	await notifyMeetUsers(env, [input.to], { type: "meet.signal", meetingId: id, from: user!.id, payload: input.payload ?? null });
	return NextResponse.json({ ok: true });
}
