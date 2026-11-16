"use client";

import { authFetch } from "@/lib/auth/client";
import type { MeetConversationDto, MeetMeetingDto, MeetMessageDto } from "./data";

export type { MeetConversationDto, MeetMeetingDto, MeetMessageDto };

export interface MeetUser {
	id: string;
	name: string;
	email: string;
	avatarKey: string | null;
	lastSeenAt: number | null;
	online: boolean;
}

export interface MeetCallLog {
	id: string;
	meetingId: string;
	initiatorId: string;
	initiatorName: string;
	meetingTitle: string;
	mediaKind: "audio" | "video";
	endReason: string | null;
	startedAt: number;
	answeredAt: number | null;
	endedAt: number | null;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
	const response = await authFetch(input, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Request failed");
	return data;
}

export const meetApi = {
	listConversations: () => request<{ conversations: MeetConversationDto[] }>("/api/meet/conversations"),
	createConversation: (input: { kind: "dm" | "group"; name?: string; memberIds: string[] }) =>
		request<{ conversation: MeetConversationDto }>("/api/meet/conversations", { method: "POST", body: JSON.stringify(input) }),
	renameConversation: (id: string, name: string) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
	leaveConversation: (id: string) => request<{ ok: true }>(`/api/meet/conversations/${id}`, { method: "DELETE" }),
	setConversationPrefs: (id: string, prefs: { muted?: boolean; pinned?: boolean; archived?: boolean }) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}`, { method: "PATCH", body: JSON.stringify(prefs) }),
	deleteConversation: (id: string) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}?all=1`, { method: "DELETE" }),
	addMeetContact: (userId: string) =>
		request<{ contact: unknown }>("/api/meet/contacts", { method: "POST", body: JSON.stringify({ userId }) }),
	listBlocks: () => request<{ blocked: { userId: string; name: string; email: string }[] }>("/api/meet/blocks"),
	blockUser: (userId: string) => request<{ ok: true }>("/api/meet/blocks", { method: "POST", body: JSON.stringify({ userId }) }),
	unblockUser: (userId: string) => request<{ ok: true }>("/api/meet/blocks", { method: "DELETE", body: JSON.stringify({ userId }) }),
	listMessages: (id: string, before?: number) =>
		request<{ messages: MeetMessageDto[] }>(`/api/meet/conversations/${id}/messages${before ? `?before=${before}` : ""}`),
	sendMessage: (id: string, body: string, replyToId?: string | null) =>
		request<{ message: MeetMessageDto }>(`/api/meet/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body, replyToId }) }),
	editMessage: (id: string, messageId: string, body: string) =>
		request<{ message: MeetMessageDto }>(`/api/meet/conversations/${id}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ body }) }),
	deleteMessage: (id: string, messageId: string) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}/messages/${messageId}`, { method: "DELETE" }),
	setTyping: (id: string, isTyping: boolean) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}/typing`, { method: "POST", body: JSON.stringify({ isTyping }) }),
	markRead: (id: string, messageId?: string) =>
		request<{ ok: true }>(`/api/meet/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ messageId }) }),
	listUsers: () => request<{ users: MeetUser[] }>("/api/meet/users"),
	listMeetings: () => request<{ meetings: MeetMeetingDto[]; calls: MeetCallLog[] }>("/api/meet/meetings"),
	createMeeting: (input: { title?: string; kind?: "instant" | "scheduled"; calendarEventId?: string; scheduledStartAt?: number; scheduledEndAt?: number; participantIds?: string[]; mediaKind?: "audio" | "video" }) =>
		request<{ meeting: MeetMeetingDto }>("/api/meet/meetings", { method: "POST", body: JSON.stringify(input) }),
	getMeeting: (id: string) => request<{ meeting: MeetMeetingDto; invited: boolean }>(`/api/meet/meetings/${id}`),
	joinByCode: (code: string) => request<{ meeting: MeetMeetingDto }>("/api/meet/meetings/join-by-code", { method: "POST", body: JSON.stringify({ code }) }),
	joinMeeting: (id: string) =>
		request<{ meeting: MeetMeetingDto; iceServers: RTCIceServer[] }>(`/api/meet/meetings/${id}/join`, { method: "POST", body: "{}" }),
	leaveMeeting: (id: string) => request<{ ok: true }>(`/api/meet/meetings/${id}/leave`, { method: "POST", body: "{}" }),
	endMeeting: (id: string) => request<{ ok: true }>(`/api/meet/meetings/${id}/end`, { method: "POST", body: "{}" }),
	sendSignal: (id: string, to: string, payload: unknown) =>
		request<{ ok: true }>(`/api/meet/meetings/${id}/signal`, { method: "POST", body: JSON.stringify({ to, payload }) }),
	callUser: (to: string, mediaKind: "audio" | "video") =>
		request<{ call: { id: string }; meeting: MeetMeetingDto }>("/api/meet/calls", { method: "POST", body: JSON.stringify({ to, mediaKind }) }),
	updateCall: (callId: string, action: "cancelled" | "declined" | "ended", to?: string) =>
		request<{ ok: true }>("/api/meet/calls", { method: "PATCH", body: JSON.stringify({ callId, action, to }) }),
	iceServers: () => request<{ iceServers: RTCIceServer[] }>("/api/meet/ice-servers"),
};
