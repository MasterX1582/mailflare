export interface NewMessageNotification {
	/** The message's full From header, e.g. `"Name" <address>`. */
	from: string;
	/** Resolved sender label: a manually named contact, otherwise this message's From name. */
	fromName: string | null;
	mailboxId: string;
	messageId: string;
	subject: string | null;
	type: "new_message";
}

export interface AgentDraftNotification {
	mailboxId: string;
	draftId: string;
	type: "agent_draft";
}

export interface MailboxRevisionRow {
	mailbox_id: string;
	revision: number;
	permission: string;
}

export interface RevisionPing {
	type: "ping";
	revision: string | null;
}

export interface RevisionNotification {
	type: "revision";
	revision: string;
	changed: boolean;
}

export interface RealtimeNotificationRequest {
	userIds: string[];
	payload: NewMessageNotification | AgentDraftNotification;
}

/* Meet: chat, presence, call and WebRTC signaling payloads ride the same per-user channel. */

export interface MeetChatNotification {
	type: "meet.chat";
	conversationId: string;
	message: import("../meet/data").MeetMessageDto;
	event?: "created" | "edited" | "deleted";
}

export interface MeetTypingNotification {
	type: "meet.typing";
	conversationId: string;
	userId: string;
	name: string;
	isTyping: boolean;
}

export interface MeetPresenceNotification {
	type: "meet.presence";
	userId: string;
	online: boolean;
	lastSeenAt: number | null;
}

export interface MeetSignalNotification {
	type: "meet.signal";
	meetingId: string;
	from: string;
	payload: unknown;
}

export interface MeetCallNotification {
	type: "meet.call";
	callId: string;
	meetingId: string;
	action: "ringing" | "answered" | "declined" | "ended" | "cancelled";
	from: { id: string; name: string };
	mediaKind: "audio" | "video";
	title: string;
}

export interface MeetRoomNotification {
	type: "meet.room";
	meetingId: string;
	event: "peer-joined" | "peer-left" | "peer-state" | "ended";
	userId: string;
	name?: string;
	state?: Record<string, unknown>;
}

export interface MeetConversationNotification {
	type: "meet.conversation";
	conversationId: string;
	event: "created" | "updated" | "deleted";
}

export type MeetNotification =
	| MeetChatNotification
	| MeetTypingNotification
	| MeetPresenceNotification
	| MeetSignalNotification
	| MeetCallNotification
	| MeetRoomNotification
	| MeetConversationNotification;
