"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import toast from "react-hot-toast";
import { Archive, ArchiveRestore, Ban, BellOff, Check, Chat, ChevronDown, ChevronRight, Pencil, Phone, Pin, Plus, Search, Send, Trash2, UserPlus, Users, Video, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/components/language-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMeetEvents } from "@/hooks/use-meet-events";
import { meetApi, type MeetConversationDto, type MeetMessageDto, type MeetUser } from "@/lib/meet/client";
import { NewChatDialog } from "./new-chat-dialog";
import { ChatCallPanel } from "./chat-call-panel";

const dayFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function conversationTitle(conversation: MeetConversationDto, selfId: string): string {
	if (conversation.name) return conversation.name;
	if (conversation.kind === "dm") {
		const other = conversation.members.find((member) => member.userId !== selfId);
		return other?.name ?? "";
	}
	return conversation.members.filter((member) => member.userId !== selfId).map((member) => member.name).join(", ");
}

function otherMember(conversation: MeetConversationDto, selfId: string) {
	return conversation.members.find((member) => member.userId !== selfId) ?? null;
}

export function MeetChatView({ conversationId }: { conversationId?: string }) {
	const { t } = useLanguage();
	const router = useRouter();
	const user = useCurrentUser();
	const selfId = user?.id ?? "";
	const [conversations, setConversations] = useState<MeetConversationDto[]>([]);
	const [activeCall, setActiveCall] = useState<{ meetingId: string; callId: string | null; mediaKind: "audio" | "video" } | null>(null);
	const [roster, setRoster] = useState<Map<string, MeetUser>>(new Map());
	const [messages, setMessages] = useState<MeetMessageDto[]>([]);
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [typing, setTyping] = useState<Map<string, number>>(new Map());
	const [replyTo, setReplyTo] = useState<MeetMessageDto | null>(null);
	const [editing, setEditing] = useState<MeetMessageDto | null>(null);
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number; conversation: MeetConversationDto } | null>(null);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const [loadingMessages, setLoadingMessages] = useState(false);
	const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastTypingSent = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);

	const active = conversations.find((conversation) => conversation.id === conversationId) ?? null;

	const loadConversations = useCallback(async () => {
		try {
			const data = await meetApi.listConversations();
			setConversations(data.conversations);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	}, [t]);

	const loadMessages = useCallback(async (id: string, before?: number) => {
		setLoadingMessages(true);
		try {
			const data = await meetApi.listMessages(id, before);
			setMessages((current) => (before ? [...data.messages, ...current] : data.messages));
			return data.messages;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
			return [];
		} finally {
			setLoadingMessages(false);
		}
	}, [t]);

	const handleMessagesScroll = () => {
		const el = scrollRef.current;
		if (!el || el.scrollTop > 60 || loadingMessages || messages.length === 0 || !conversationId) return;
		const previousHeight = el.scrollHeight;
		void loadMessages(conversationId, messages[0].createdAt).then(() => {
			requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - previousHeight; });
		});
	};
	useEffect(() => {
		let cancelled = false;
		void meetApi.listConversations()
			.then((data) => { if (!cancelled) setConversations(data.conversations); })
			.catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : t("meet.loadError")); });
		void meetApi.listUsers()
			.then((data) => { if (!cancelled) setRoster(new Map(data.users.map((member) => [member.id, member]))); })
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [t]);

	// Answered a call notification: /meet/chat/<id>?call=<meetingId>&media=audio|video opens the in-chat call.
	// The custom event covers accepting while already on this conversation (no remount, no query change).
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const call = params.get("call");
		// Only honor the param for a genuinely ringing call — a bare meeting id in a
		// link must never auto-join the user into someone's room with live media.
		if (call) {
			void meetApi.listMeetings()
				.then(({ calls }) => {
					if (calls.some((entry) => entry.meetingId === call && !entry.endedAt)) {
						setActiveCall({ meetingId: call, callId: null, mediaKind: params.get("media") === "audio" ? "audio" : "video" });
					}
				})
				.catch(() => undefined);
		}
		const onAccept = (event: Event) => {
			const detail = (event as CustomEvent<{ meetingId: string; conversationId: string; mediaKind: "audio" | "video" }>).detail;
			if (detail.conversationId === conversationId) setActiveCall({ meetingId: detail.meetingId, callId: null, mediaKind: detail.mediaKind });
		};
		window.addEventListener("meet:accept-call", onAccept);
		return () => window.removeEventListener("meet:accept-call", onAccept);
	}, [conversationId]);

	// Conversation state resets via key={conversationId} on the view; this effect only loads.
	useEffect(() => {
		if (!conversationId) return;
		let cancelled = false;
		void Promise.resolve()
			.then(() => { if (!cancelled) setLoadingMessages(true); })
			.then(() => meetApi.listMessages(conversationId))
			.then((data) => {
				if (cancelled) return;
				setMessages(data.messages);
				const last = data.messages.at(-1);
				if (last) void meetApi.markRead(conversationId, last.id).catch(() => undefined);
			})
			.catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : t("meet.loadError")); })
			.finally(() => { if (!cancelled) setLoadingMessages(false); });
		return () => { cancelled = true; };
	}, [conversationId, t]);

	const markRead = useCallback((id: string, messageId?: string) => {
		void meetApi.markRead(id, messageId).catch(() => undefined);
		setConversations((current) => current.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)));
	}, []);

	useMeetEvents(useCallback((event) => {
		if (event.type === "meet.chat") {
			if (event.event === "deleted") {
				setMessages((current) => current.filter((message) => message.id !== event.message.id));
				return;
			}
			const incoming = event.message;
			if (event.event === "edited") {
				setMessages((current) => current.map((message) => (message.id === incoming.id ? { ...message, ...incoming, replyTo: message.replyTo } : message)));
				return;
			}
			setConversations((current) => {
				const exists = current.some((c) => c.id === event.conversationId);
				if (!exists) return current;
				return current.map((c) =>
					c.id === event.conversationId
						? { ...c, lastMessageAt: incoming.createdAt, lastMessage: { id: incoming.id, senderName: incoming.senderName, body: incoming.body, createdAt: incoming.createdAt }, unreadCount: c.id === conversationId ? 0 : c.mutedAt != null ? c.unreadCount : c.unreadCount + (incoming.senderId === selfId ? 0 : 1) }
						: c,
				);
			});
			if (event.conversationId === conversationId) {
				setMessages((current) => (current.some((message) => message.id === incoming.id) ? current : [...current, incoming]));
				if (incoming.senderId !== selfId) markRead(event.conversationId, incoming.id);
			} else {
				void loadConversations();
			}
		} else if (event.type === "meet.typing") {
			if (event.conversationId !== conversationId) return;
			setTyping((current) => {
				const next = new Map(current);
				if (event.isTyping) next.set(event.userId, Date.now() + 5000);
				else next.delete(event.userId);
				return next;
			});
		} else if (event.type === "meet.presence") {
			setRoster((current) => {
				const next = new Map(current);
				const existing = next.get(event.userId);
				if (existing) next.set(event.userId, { ...existing, online: event.online, lastSeenAt: event.lastSeenAt });
				return next;
			});
		} else if (event.type === "meet.conversation") {
			void loadConversations();
		}
	}, [conversationId, selfId, markRead, loadConversations]));

	// Typing indicators expire after five seconds without a refresh.
	useEffect(() => {
		const timer = setInterval(() => {
			setTyping((current) => {
				const now = Date.now();
				let changed = false;
				const next = new Map(current);
				for (const [userId, expires] of next) {
					if (expires < now) {
						next.delete(userId);
						changed = true;
					}
				}
				return changed ? next : current;
			});
		}, 1000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, typing]);

	const sendDraft = async () => {
		const body = draft.trim();
		if (!body || !conversationId) return;
		try {
			if (editing) {
				const { message } = await meetApi.editMessage(conversationId, editing.id, body);
				setMessages((current) => current.map((row) => (row.id === message.id ? { ...row, ...message, replyTo: row.replyTo } : row)));
				setEditing(null);
			} else {
				const { message } = await meetApi.sendMessage(conversationId, body, replyTo?.id ?? null);
				setMessages((current) => (current.some((row) => row.id === message.id) ? current : [...current, message]));
				setReplyTo(null);
			}
			setDraft("");
			void meetApi.setTyping(conversationId, false).catch(() => undefined);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.sendError"));
		}
	};

	const onDraftChange = (value: string) => {
		setDraft(value);
		if (!conversationId) return;
		const now = Date.now();
		if (value && now - lastTypingSent.current > 2500) {
			lastTypingSent.current = now;
			void meetApi.setTyping(conversationId, true).catch(() => undefined);
			if (typingTimer.current) clearTimeout(typingTimer.current);
			typingTimer.current = setTimeout(() => void meetApi.setTyping(conversationId, false).catch(() => undefined), 4000);
		}
	};

	const applyPrefs = async (conversation: MeetConversationDto, prefs: { muted?: boolean; pinned?: boolean; archived?: boolean }) => {
		try {
			await meetApi.setConversationPrefs(conversation.id, prefs);
			const now = Math.floor(Date.now() / 1000);
			setConversations((current) =>
				current.map((c) =>
					c.id === conversation.id
						? {
								...c,
								mutedAt: prefs.muted === undefined ? c.mutedAt : prefs.muted ? now : null,
								pinnedAt: prefs.pinned === undefined ? c.pinnedAt : prefs.pinned ? now : null,
								archivedAt: prefs.archived === undefined ? c.archivedAt : prefs.archived ? now : null,
							}
						: c,
				),
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	};

	const addToContacts = async (conversation: MeetConversationDto) => {
		const other = otherMember(conversation, selfId);
		if (!other) return;
		try {
			await meetApi.addMeetContact(other.userId);
			toast.success(t("meet.contactAdded"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	};

	const leaveConversation = async (conversation: MeetConversationDto) => {
		try {
			await meetApi.leaveConversation(conversation.id);
			setConversations((current) => current.filter((c) => c.id !== conversation.id));
			if (conversation.id === conversationId) router.push("/meet/chat");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	};

	// "Delete" removes the conversation for everyone when the caller owns a
	// group/meeting chat; for a dm it removes the caller's membership (the other
	// side keeps their copy — server enforces this either way).
	const deleteConversation = async (conversation: MeetConversationDto) => {
		const own = conversation.members.find((member) => member.userId === selfId);
		try {
			if (conversation.kind !== "dm" && own?.role === "owner") {
				await meetApi.deleteConversation(conversation.id);
			} else {
				await meetApi.leaveConversation(conversation.id);
			}
			setConversations((current) => current.filter((c) => c.id !== conversation.id));
			if (conversation.id === conversationId) router.push("/meet/chat");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	};

	const toggleBlock = async (conversation: MeetConversationDto) => {
		const other = otherMember(conversation, selfId);
		if (!other) return;
		try {
			if (other.blocked) {
				await meetApi.unblockUser(other.userId);
				toast.success(t("meet.unblockedDone"));
			} else {
				await meetApi.blockUser(other.userId);
				toast.success(t("meet.blockedDone"));
			}
			await loadConversations();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.loadError"));
		}
	};

	const startCall = async (mediaKind: "audio" | "video") => {
		if (!active) return;
		try {
			const otherIds = active.members.filter((member) => member.userId !== selfId).map((member) => member.userId);
			if (!otherIds.length) return;
			if (otherIds.length === 1) {
				// 1:1 calls stay inside the chat — even for conversations created by a call (kind "meeting").
				const { call, meeting } = await meetApi.callUser(otherIds[0], mediaKind);
				setActiveCall({ meetingId: meeting.id, callId: call.id, mediaKind });
				return;
			}
			if (active.kind === "meeting" && active.meetingId) {
				router.push(`/meet/call/${active.meetingId}`);
				return;
			}
			const { meeting } = await meetApi.createMeeting({ kind: "instant", title: conversationTitle(active, selfId), participantIds: otherIds, mediaKind });
			router.push(`/meet/call/${meeting.id}?media=${mediaKind}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.callError"));
		}
	};

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = q ? conversations.filter((conversation) => conversationTitle(conversation, selfId).toLowerCase().includes(q)) : conversations;
		return {
			visible: matches.filter((c) => c.archivedAt == null),
			archived: matches.filter((c) => c.archivedAt != null),
		};
	}, [conversations, query, selfId]);

	const renderConversationRow = (conversation: MeetConversationDto) => {
		const other = conversation.kind === "dm" ? otherMember(conversation, selfId) : null;
		const online = other ? roster.get(other.userId)?.online : false;
		const selected = conversation.id === conversationId;
		return (
			<button
				key={conversation.id}
				type="button"
				onClick={() => router.push(`/meet/chat/${conversation.id}`)}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ x: event.clientX, y: event.clientY, conversation });
				}}
				className={clsx("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50", selected && "bg-[#e8f0fe] hover:bg-[#e8f0fe]")}
			>
				<span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1a5fd7]/10 text-sm font-semibold text-[#1a5fd7]">
					{conversation.kind === "group" ? <Users size={16} /> : (conversationTitle(conversation, selfId).charAt(0) || "?").toUpperCase()}
					{online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-center justify-between gap-2">
						<span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-neutral-900">
							{conversation.pinnedAt != null && <Pin size={12} className="shrink-0 text-[#1a5fd7]" />}
							<span className="truncate">{conversationTitle(conversation, selfId) || t("meet.untitled")}</span>
						</span>
						{conversation.lastMessageAt && <span className="shrink-0 text-xs text-neutral-400">{shortDateFormat.format(conversation.lastMessageAt * 1000)}</span>}
					</span>
					<span className="flex items-center justify-between gap-2">
						<span className="truncate text-xs text-neutral-500">
							{conversation.lastMessage ? `${conversation.lastMessage.senderName}: ${conversation.lastMessage.body}` : t("meet.noMessages")}
						</span>
						{conversation.mutedAt != null ? (
							<BellOff size={14} className="shrink-0 text-neutral-300" />
						) : (
							conversation.unreadCount > 0 && (
								<span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#1a5fd7] px-1.5 text-xs font-semibold text-white">{conversation.unreadCount}</span>
							)
						)}
					</span>
				</span>
			</button>
		);
	};

	const typingNames = [...typing.keys()]
		.map((userId) => active?.members.find((member) => member.userId === userId)?.name ?? roster.get(userId)?.name)
		.filter(Boolean) as string[];

	const decoratedMessages = useMemo(() => {
		const days = messages.map((message) => dayFormat.format(message.createdAt * 1000));
		return messages.map((message, index) => ({ message, day: days[index], showDay: index === 0 || days[index] !== days[index - 1] }));
	}, [messages]);

	return (
		<div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
			{/* Conversation list */}
			<div className={clsx("flex w-full min-w-0 flex-col border-neutral-200 md:w-80 md:shrink-0 md:border-r", conversationId && "hidden md:flex")}>
				<div className="flex items-center gap-2 border-b border-neutral-200 p-3">
					<div className="relative flex-1">
						<Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
						<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("meet.searchChats")} className="pl-9" />
					</div>
					<Button size="sm" onClick={() => setNewChatOpen(true)} aria-label={t("meet.newChat")}>
						<Plus size={16} />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{filtered.visible.length === 0 && filtered.archived.length === 0 && (
						<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-neutral-500">
							<Chat size={28} className="text-neutral-300" />
							{t("meet.noChats")}
						</div>
					)}
					{filtered.visible.map(renderConversationRow)}
					{filtered.archived.length > 0 && (
						<div className="border-t border-neutral-200">
							<button
								type="button"
								onClick={() => setArchivedOpen((open) => !open)}
								className="flex w-full items-center gap-1.5 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:bg-neutral-50"
							>
								{archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
								{t("meet.archivedSection", { count: filtered.archived.length })}
							</button>
							{archivedOpen && filtered.archived.map(renderConversationRow)}
						</div>
					)}
				</div>
			</div>

			{/* Message pane */}
			<div className={clsx("flex min-w-0 flex-1 flex-col", !conversationId && "hidden md:flex")}>
				{!active ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
						<Chat size={40} className="text-neutral-300" />
						<p className="text-sm">{t("meet.pickConversation")}</p>
						<Button variant="secondary" onClick={() => setNewChatOpen(true)}>{t("meet.newChat")}</Button>
					</div>
				) : (
					<>
						<div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-3">
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-semibold text-neutral-900">{conversationTitle(active, selfId) || t("meet.untitled")}</p>
								<p className="truncate text-xs text-neutral-500">
									{active.kind === "dm"
										? (roster.get(otherMember(active, selfId)?.userId ?? "")?.online ? t("meet.online") : t("meet.offline"))
										: active.kind === "meeting"
											? t("meet.meetingChat")
											: t("meet.memberCount", { count: active.members.length })}
								</p>
							</div>
							<Button variant="secondary" size="sm" onClick={() => void startCall("audio")} aria-label={t("meet.audioCall")}>
								<Phone size={16} />
							</Button>
							<Button variant="secondary" size="sm" onClick={() => void startCall("video")} aria-label={t("meet.videoCall")}>
								<Video size={16} />
							</Button>
						</div>
						{activeCall && (
							<div className="border-b border-neutral-200 p-3">
								<ChatCallPanel
									meetingId={activeCall.meetingId}
									callId={activeCall.callId}
									mediaKind={activeCall.mediaKind}
									selfId={selfId}
									otherName={otherMember(active, selfId)?.name ?? ""}
									onClose={() => setActiveCall(null)}
								/>
							</div>
						)}
						<div ref={scrollRef} onScroll={handleMessagesScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
							{loadingMessages && messages.length === 0 && <p className="py-8 text-center text-sm text-neutral-400">{t("meet.loading")}</p>}
							{decoratedMessages.map(({ message, day, showDay }) => {
								const own = message.senderId === selfId;
								if (message.type !== "text") {
									return (
										<div key={message.id}>
											{showDay && <DaySeparator label={day} />}
											<p className="py-2 text-center text-xs text-neutral-400">{message.body}</p>
										</div>
									);
								}
								return (
									<div key={message.id}>
										{showDay && <DaySeparator label={day} />}
										<div className={clsx("group mb-1 flex", own ? "justify-end" : "justify-start")}>
											<div className={clsx("max-w-[75%] rounded-2xl px-3.5 py-2", own ? "bg-[#1a5fd7] text-white" : "bg-neutral-100 text-neutral-900")}>
												{!own && active.kind !== "dm" && <p className="mb-0.5 text-xs font-semibold text-[#1a5fd7]">{message.senderName}</p>}
												{message.replyTo && (
													<div className={clsx("mb-1 rounded-lg border-l-2 px-2 py-1 text-xs", own ? "border-white/50 bg-white/10" : "border-[#1a5fd7]/50 bg-[#1a5fd7]/5")}>
														<p className="font-semibold">{message.replyTo.senderName}</p>
														<p className="truncate opacity-80">{message.replyTo.body}</p>
													</div>
												)}
												<p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
												<p className={clsx("mt-0.5 flex items-center justify-end gap-1 text-[10px]", own ? "text-white/70" : "text-neutral-400")}>
													{message.editedAt && <span>{t("meet.edited")}</span>}
													{timeFormat.format(message.createdAt * 1000)}
												</p>
											</div>
											{own && (
												<div className="invisible ml-1 flex items-center gap-0.5 group-hover:visible">
													<button type="button" className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" aria-label={t("meet.edit")} onClick={() => { setEditing(message); setDraft(message.body); }}>
														<Pencil size={14} />
													</button>
													<button
														type="button"
														className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600"
														aria-label={t("meet.delete")}
														onClick={() => void meetApi.deleteMessage(active.id, message.id).then(() => setMessages((current) => current.filter((row) => row.id !== message.id))).catch(() => undefined)}
													>
														<Trash2 size={14} />
													</button>
												</div>
											)}
											{!own && (
												<div className="invisible ml-1 flex items-center group-hover:visible">
													<button type="button" className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" aria-label={t("meet.reply")} onClick={() => setReplyTo(message)}>
														<Check size={14} />
													</button>
												</div>
											)}
										</div>
									</div>
								);
							})}
							{typingNames.length > 0 && <p className="py-1 text-xs italic text-neutral-400">{t("meet.typing", { names: typingNames.join(", ") })}</p>}
						</div>
						<div className="border-t border-neutral-200 p-3">
							{editing && (
								<ComposerBanner label={`${t("meet.editingMessage")}: ${editing.body.slice(0, 60)}`} onClose={() => { setEditing(null); setDraft(""); }} />
							)}
							{replyTo && !editing && (
								<ComposerBanner label={`${t("meet.replyingTo")} ${replyTo.senderName}: ${replyTo.body.slice(0, 60)}`} onClose={() => setReplyTo(null)} />
							)}
							<div className="flex items-end gap-2">
								<Textarea
									value={draft}
									onChange={(event) => onDraftChange(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											void sendDraft();
										}
									}}
									placeholder={t("meet.messagePlaceholder")}
									rows={2}
									className="min-h-10 flex-1 resize-none"
								/>
								<Button onClick={() => void sendDraft()} disabled={!draft.trim()} aria-label={t("meet.send")}>
									<Send size={16} />
								</Button>
							</div>
						</div>
					</>
				)}
			</div>
			<NewChatDialog open={newChatOpen} onClose={() => setNewChatOpen(false)} roster={[...roster.values()]} onCreated={(id) => { setNewChatOpen(false); void loadConversations().then(() => router.push(`/meet/chat/${id}`)); }} />
			{menu && (
				<ConversationMenu
					x={menu.x}
					y={menu.y}
					conversation={menu.conversation}
					selfId={selfId}
					onClose={() => setMenu(null)}
					onTogglePinned={(c) => void applyPrefs(c, { pinned: c.pinnedAt == null })}
					onToggleMuted={(c) => void applyPrefs(c, { muted: c.mutedAt == null })}
					onAddContact={(c) => void addToContacts(c)}
					onToggleBlock={(c) => void toggleBlock(c)}
					onToggleArchived={(c) => void applyPrefs(c, { archived: c.archivedAt == null })}
					onLeave={(c) => void leaveConversation(c)}
					onDelete={(c) => void deleteConversation(c)}
				/>
			)}
		</div>
	);
}

function ConversationMenu({
	x,
	y,
	conversation,
	selfId,
	onClose,
	onTogglePinned,
	onToggleMuted,
	onAddContact,
	onToggleBlock,
	onToggleArchived,
	onLeave,
	onDelete,
}: {
	x: number;
	y: number;
	conversation: MeetConversationDto;
	selfId: string;
	onClose: () => void;
	onTogglePinned: (c: MeetConversationDto) => void;
	onToggleMuted: (c: MeetConversationDto) => void;
	onAddContact: (c: MeetConversationDto) => void;
	onToggleBlock: (c: MeetConversationDto) => void;
	onToggleArchived: (c: MeetConversationDto) => void;
	onLeave: (c: MeetConversationDto) => void;
	onDelete: (c: MeetConversationDto) => void;
}) {
	const { t } = useLanguage();
	const other = conversation.kind === "dm" ? (conversation.members.find((member) => member.userId !== selfId) ?? null) : null;
	const items: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }[] = [
		{ icon: <Pin size={15} />, label: conversation.pinnedAt != null ? t("meet.unprioritize") : t("meet.prioritize"), onClick: () => onTogglePinned(conversation) },
		{ icon: <BellOff size={15} />, label: conversation.mutedAt != null ? t("meet.unmuteChat") : t("meet.muteChat"), onClick: () => onToggleMuted(conversation) },
	];
	if (other) {
		items.push(
			{ icon: <UserPlus size={15} />, label: t("meet.addToContacts"), onClick: () => onAddContact(conversation) },
			{ icon: <Ban size={15} />, label: other.blocked ? t("meet.unblock") : t("meet.block"), danger: !other.blocked, onClick: () => onToggleBlock(conversation) },
		);
	}
	items.push({
		icon: conversation.archivedAt != null ? <ArchiveRestore size={15} /> : <Archive size={15} />,
		label: conversation.archivedAt != null ? t("meet.unarchive") : t("meet.archive"),
		onClick: () => onToggleArchived(conversation),
	});
	if (conversation.kind !== "dm") {
		items.push({ icon: <Trash2 size={15} />, label: t("meet.leaveChat"), onClick: () => onLeave(conversation) });
	}
	const own = conversation.members.find((member) => member.userId === selfId);
	if (conversation.kind === "dm" || own?.role === "owner") {
		items.push({ icon: <Trash2 size={15} />, label: t("meet.deleteChat"), danger: true, onClick: () => onDelete(conversation) });
	}
	return (
		<>
			<div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
			<div
				className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
				style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - items.length * 40 - 16) }}
			>
				{items.map((item) => (
					<button
						key={item.label}
						type="button"
						className={clsx("flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-neutral-50", item.danger ? "text-red-600" : "text-neutral-700")}
						onClick={() => {
							onClose();
							item.onClick();
						}}
					>
						{item.icon}
						{item.label}
					</button>
				))}
			</div>
		</>
	);
}

function DaySeparator({ label }: { label: string }) {
	return (
		<div className="my-3 flex items-center gap-3">
			<div className="h-px flex-1 bg-neutral-200" />
			<span className="text-xs text-neutral-400">{label}</span>
			<div className="h-px flex-1 bg-neutral-200" />
		</div>
	);
}

function ComposerBanner({ label, onClose }: { label: string; onClose: () => void }) {
	return (
		<div className="mb-2 flex items-center justify-between rounded-lg bg-neutral-100 px-3 py-1.5 text-xs text-neutral-600">
			<span className="truncate">{label}</span>
			<button type="button" onClick={onClose} className="ml-2 rounded p-0.5 text-neutral-400 hover:text-neutral-600" aria-label="Close">
				<X size={14} />
			</button>
		</div>
	);
}
