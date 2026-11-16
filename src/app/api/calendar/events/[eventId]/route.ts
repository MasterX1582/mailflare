import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, meetConversationMembers, meetMeetings, meetParticipants } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import type { CalendarEventInput } from "../types";
import type { CalendarEventRouteParams } from "./types";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeat, normalizeCalendarRepeatDays, parseCalendarOccurrenceId, parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { newId } from "@/lib/ids";
import { getRequestTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { createMeeting, userIdsForEmails } from "@/lib/meet/data";
import { notifyMeetUsers } from "@/lib/meet/realtime";

export async function PATCH(request: Request, { params }: CalendarEventRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { eventId } = await params;
	const occurrence = parseCalendarOccurrenceId(eventId);
	const input = await request.json() as CalendarEventInput;
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : occurrence?.startsAt;
	if (!input.title?.trim() || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return NextResponse.json({ error: "Enter a title and valid event times" }, { status: 400 });
	if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return NextResponse.json({ error: "Invalid repeat start" }, { status: 400 });
	const db = getDb(env);
	const [existing] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, occurrence?.seriesId ?? eventId), eq(calendarEvents.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });
	const timeZone = input.timeZone ? normalizeTimeZone(input.timeZone) : existing.timeZone ?? getRequestTimeZone(request, user.timeZone);
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && existing.repeatUntil && effectiveFrom >= existing.repeatUntil) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (attendees.length > 50) return NextResponse.json({ error: "Too many attendees" }, { status: 400 });
	if (attendees.length && existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	if (input.moveOccurrenceToPast) {
		if (!occurrence || existing.repeat === "none" || startsAt >= new Date()) return NextResponse.json({ error: "Choose a past time for this occurrence" }, { status: 400 });
		const excluded = parseExcludedOccurrences(existing.excludedOccurrences);
		if (excluded.includes(occurrence.startsAt.getTime())) return NextResponse.json({ error: "Occurrence already moved" }, { status: 409 });
		const now = new Date();
		const moved = { ...existing, id: newId("evt"), meetingId: null, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", startsAt, endsAt, createdAt: now, updatedAt: now };
		await db.insert(calendarEvents).values(moved);
		await db.update(calendarEvents).set({ excludedOccurrences: JSON.stringify([...excluded, occurrence.startsAt.getTime()]), updatedAt: now }).where(eq(calendarEvents.id, existing.id));
		if (attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...moved, uid: moved.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${moved.title}`, text: moved.description || `This event has been updated: ${moved.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
		return NextResponse.json({ ok: true });
	}
	const repeat = normalizeCalendarRepeat(input.repeat ?? existing.repeat);
	const repeatDays = repeat === "weekdays" ? normalizeCalendarRepeatDays(input.repeatDays ?? (existing.repeat === "weekdays" ? parseCalendarRepeatDays(existing.repeatDays) : DEFAULT_REPEAT_DAYS)) : [];
	if (repeat === "weekdays" && repeatDays.length === 0) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const repeatAnchorDay = repeat === "monthly" && Number.isInteger(input.repeatAnchorDay) && input.repeatAnchorDay! >= 1 && input.repeatAnchorDay! <= 31 ? input.repeatAnchorDay : repeat === "monthly" ? existing.repeatAnchorDay : null;
	const event = { ...existing, timeZone, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), repeat, repeatDays: JSON.stringify(repeatDays), repeatAnchorDay, repeatUntil: repeat === "none" ? null : existing.repeatUntil, reminderMinutes: input.reminderMinutes === undefined ? existing.reminderMinutes : normalizeReminderMinutes(input.reminderMinutes), lastRemindedStart: null, startsAt, endsAt };
	const splitAt = existing.repeat !== "none" ? effectiveFrom : null;
	const split = splitAt && splitAt > existing.startsAt;
	// The Meet call follows the part of the series the edit applies to; a split moves it to the new future series.
	const targetEventId = split ? newId("evt") : existing.id;
	let meetingId = existing.meetingId;
	if (input.addMeetCall && !meetingId && user.meetEnabled) {
		const attendeeIds = await userIdsForEmails(db, attendees);
		const meeting = await createMeeting(db, user, { title: event.title, kind: "scheduled", calendarEventId: targetEventId, scheduledStartAt: startsAt, scheduledEndAt: endsAt, participantIds: attendeeIds });
		if (attendeeIds.length) await notifyMeetUsers(env, attendeeIds, { type: "meet.conversation", conversationId: meeting.conversationId!, event: "created" });
		meetingId = meeting.id;
	} else if (meetingId) {
		await db.update(meetMeetings).set({ title: event.title, scheduledStartAt: startsAt, scheduledEndAt: endsAt, calendarEventId: targetEventId }).where(eq(meetMeetings.id, meetingId));
		// Attendees added to an already-linked event are enrolled like on create.
		const attendeeIds = await userIdsForEmails(db, attendees);
		if (attendeeIds.length) {
			const mid = meetingId;
			const existing = await db.select({ userId: meetParticipants.userId }).from(meetParticipants).where(eq(meetParticipants.meetingId, mid));
			const existingIds = new Set(existing.map((row) => row.userId));
			const added = attendeeIds.filter((id) => !existingIds.has(id));
			if (added.length) {
				await db.insert(meetParticipants).values(added.map((userId) => ({ id: newId("mpt"), meetingId: mid, userId, role: "participant" as const, state: "invited" as const })));
				const [meeting] = await db.select({ conversationId: meetMeetings.conversationId }).from(meetMeetings).where(eq(meetMeetings.id, mid)).limit(1);
				if (meeting?.conversationId) {
					await db
						.insert(meetConversationMembers)
						.values(added.map((userId) => ({ id: newId("mcm"), conversationId: meeting.conversationId!, userId, role: "member" as const, joinedAt: new Date() })))
						.onConflictDoNothing();
					await notifyMeetUsers(env, added, { type: "meet.conversation", conversationId: meeting.conversationId, event: "created" });
				}
			}
		}
	}
	if (split) {
		const now = new Date();
		await db.insert(calendarEvents).values({ ...event, id: targetEventId, meetingId, createdAt: now, updatedAt: now });
		await db.update(calendarEvents).set({ repeatUntil: splitAt, meetingId: null, updatedAt: now }).where(eq(calendarEvents.id, existing.id));
	} else {
		await db.update(calendarEvents).set({ title: event.title, description: event.description, location: event.location, attendees: event.attendees, color: event.color, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil, reminderMinutes: event.reminderMinutes, lastRemindedStart: null, timeZone, startsAt, endsAt, meetingId, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
	}
	if (attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...event, uid: existing.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${event.title}`, text: event.description || `This event has been updated: ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: CalendarEventRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { eventId } = await params;
	const occurrence = parseCalendarOccurrenceId(eventId);
	const input = await request.json().catch(() => ({})) as CalendarEventInput;
	const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : occurrence?.startsAt;
	if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return NextResponse.json({ error: "Invalid repeat start" }, { status: 400 });
	const db = getDb(env);
	const [existing] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, occurrence?.seriesId ?? eventId), eq(calendarEvents.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && effectiveFrom > existing.startsAt) {
		await db.update(calendarEvents).set({ repeatUntil: effectiveFrom, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
	} else {
		if (existing.meetingId) await db.update(meetMeetings).set({ status: "ended", endedAt: new Date() }).where(eq(meetMeetings.id, existing.meetingId));
		await db.delete(calendarEvents).where(eq(calendarEvents.id, existing.id));
	}
	return NextResponse.json({ ok: true });
}
