"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import toast from "react-hot-toast";
import { Chat, Mic, MicOff, PhoneOff, ScreenShare, Send, Video, VideoOff, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/components/language-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMeetEvents } from "@/hooks/use-meet-events";
import { meetApi, type MeetMeetingDto, type MeetMessageDto } from "@/lib/meet/client";
import { MeetPeerManager } from "@/lib/meet/peer-manager";

type Phase = "loading" | "lobby" | "incall" | "ended" | "error";

interface RemoteTile {
	userId: string;
	name: string;
	stream: MediaStream;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function MeetCallView({ meetingId }: { meetingId: string }) {
	const { t } = useLanguage();
	const router = useRouter();
	const user = useCurrentUser();
	const selfId = user?.id ?? "";
	const [phase, setPhase] = useState<Phase>("loading");
	const [meeting, setMeeting] = useState<MeetMeetingDto | null>(null);
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [mediaIssue, setMediaIssue] = useState<"insecure" | "denied" | "missing" | null>(null);
	const [micOn, setMicOn] = useState(true);
	const [camOn, setCamOn] = useState(true);
	const [sharing, setSharing] = useState(false);
	const [tiles, setTiles] = useState<RemoteTile[]>([]);
	const [chatOpen, setChatOpen] = useState(false);
	const [chatMessages, setChatMessages] = useState<MeetMessageDto[]>([]);
	const [chatDraft, setChatDraft] = useState("");
	const [unreadChat, setUnreadChat] = useState(0);
	const names = useRef<Map<string, string>>(new Map());
	const managerRef = useRef<MeetPeerManager | null>(null);
	const localStreamRef = useRef<MediaStream | null>(null);
	const localVideoRef = useRef<HTMLVideoElement>(null);
	const lobbyVideoRef = useRef<HTMLVideoElement>(null);
	const chatScrollRef = useRef<HTMLDivElement>(null);

	// Load the meeting + camera preview for the lobby.
	useEffect(() => {
		let cancelled = false;
		let stream: MediaStream | null = null;
		(async () => {
			try {
				const { meeting: dto } = await meetApi.getMeeting(meetingId);
				if (cancelled) return;
				setMeeting(dto);
				for (const participant of dto.participants) names.current.set(participant.userId, participant.name);
				// Audio calls never request the camera.
				const audioOnly = new URLSearchParams(window.location.search).get("media") === "audio";
				if (audioOnly) setCamOn(false);
				if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
					setMediaIssue("insecure");
				} else {
					try {
						stream = await navigator.mediaDevices.getUserMedia({ video: !audioOnly, audio: true });
					} catch (firstError) {
						try {
							stream = await navigator.mediaDevices.getUserMedia({ audio: true });
							setCamOn(false);
						} catch (secondError) {
							const failure: unknown = secondError ?? firstError;
							const name = failure instanceof DOMException ? failure.name : "";
							setMediaIssue(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "missing");
						}
					}
				}
				if (cancelled) {
					stream?.getTracks().forEach((track) => track.stop());
					return;
				}
				localStreamRef.current = stream;
				setLocalStream(stream);
				setPhase("lobby");
			} catch (error) {
				if (!cancelled) {
					toast.error(error instanceof Error ? error.message : t("meet.notFound"));
					setPhase("error");
				}
			}
		})();
		return () => {
			cancelled = true;
			managerRef.current?.destroy();
			managerRef.current = null;
			localStreamRef.current?.getTracks().forEach((track) => track.stop());
			localStreamRef.current = null;
		};
	}, [meetingId, t]);

	useEffect(() => {
		const video = phase === "lobby" ? lobbyVideoRef.current : localVideoRef.current;
		if (video && localStream) video.srcObject = localStream;
	}, [phase, localStream]);

	const teardown = useCallback(() => {
		managerRef.current?.destroy();
		managerRef.current = null;
		localStream?.getTracks().forEach((track) => track.stop());
		localStreamRef.current = null;
		setLocalStream(null);
		setTiles([]);
	}, [localStream]);

	const leave = useCallback(async () => {
		teardown();
		await meetApi.leaveMeeting(meetingId).catch(() => undefined);
		router.push("/meet/meetings");
	}, [teardown, meetingId, router]);

	const join = async () => {
		try {
			const { meeting: dto, iceServers } = await meetApi.joinMeeting(meetingId);
			setMeeting(dto);
			for (const participant of dto.participants) names.current.set(participant.userId, participant.name);
			localStream?.getAudioTracks().forEach((track) => (track.enabled = micOn));
			localStream?.getVideoTracks().forEach((track) => (track.enabled = camOn));
			const manager = new MeetPeerManager({
				meetingId,
				selfId,
				iceServers,
				sendSignal: (to, payload) => meetApi.sendSignal(meetingId, to, payload),
				onTrack: (userId, stream) => {
					setTiles((current) => {
						const next = current.filter((tile) => tile.userId !== userId);
						return [...next, { userId, name: names.current.get(userId) ?? "", stream }];
					});
				},
				onPeerClosed: (userId) => setTiles((current) => current.filter((tile) => tile.userId !== userId)),
			});
			managerRef.current = manager;
			manager.setLocalStream(localStream);
			// Already-in-room participants are peers we connect to; they also get
			// our peer-joined broadcast and ensurePeer on their side.
			for (const participant of dto.participants) {
				if (participant.userId !== selfId && participant.state === "joined") manager.ensurePeer(participant.userId);
			}
			setPhase("incall");
			if (dto.conversationId) {
				const { messages } = await meetApi.listMessages(dto.conversationId);
				setChatMessages(messages);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.joinError"));
		}
	};

	useMeetEvents(useCallback((event) => {
		if (event.type === "meet.signal" && event.meetingId === meetingId) {
			names.current.set(event.from, names.current.get(event.from) ?? "");
			void managerRef.current?.handleSignal(event.from, event.payload);
		} else if (event.type === "meet.room" && event.meetingId === meetingId) {
			if (event.event === "peer-joined" && event.userId !== selfId) {
				if (event.name) names.current.set(event.userId, event.name);
				managerRef.current?.ensurePeer(event.userId);
			} else if (event.event === "peer-left") {
				managerRef.current?.removePeer(event.userId);
			} else if (event.event === "ended") {
				teardown();
				setPhase("ended");
			}
		} else if (event.type === "meet.chat" && meeting?.conversationId === event.conversationId && event.event !== "deleted") {
			const incoming = event.message;
			setChatMessages((current) => (current.some((message) => message.id === incoming.id) ? current : [...current, incoming]));
			if (!chatOpen && incoming.senderId !== selfId) setUnreadChat((count) => count + 1);
		}
	}, [meetingId, selfId, meeting?.conversationId, chatOpen, teardown]));

	// Leave on tab close.
	useEffect(() => {
		if (phase !== "incall") return;
		const handler = () => navigator.sendBeacon(`/api/meet/meetings/${meetingId}/leave`, new Blob([], { type: "application/json" }));
		window.addEventListener("pagehide", handler);
		return () => window.removeEventListener("pagehide", handler);
	}, [phase, meetingId]);

	useEffect(() => {
		const el = chatScrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chatMessages, chatOpen]);

	const toggleMic = () => {
		setMicOn((on) => {
			localStream?.getAudioTracks().forEach((track) => (track.enabled = !on));
			return !on;
		});
	};

	const toggleCam = () => {
		setCamOn((on) => {
			localStream?.getVideoTracks().forEach((track) => (track.enabled = !on));
			return !on;
		});
	};

	const toggleShare = async () => {
		if (sharing) {
			const cameraTrack = localStream?.getVideoTracks()[0] ?? null;
			await managerRef.current?.replaceVideoTrack(cameraTrack);
			setSharing(false);
			return;
		}
		try {
			const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
			const [track] = display.getVideoTracks();
			track.onended = () => {
				const cameraTrack = localStream?.getVideoTracks()[0] ?? null;
				void managerRef.current?.replaceVideoTrack(cameraTrack);
				setSharing(false);
			};
			await managerRef.current?.replaceVideoTrack(track);
			setSharing(true);
		} catch {
			// User cancelled the picker.
		}
	};

	const sendChat = async () => {
		const body = chatDraft.trim();
		if (!body || !meeting?.conversationId) return;
		try {
			const { message } = await meetApi.sendMessage(meeting.conversationId, body);
			setChatMessages((current) => (current.some((row) => row.id === message.id) ? current : [...current, message]));
			setChatDraft("");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.sendError"));
		}
	};

	const isHost = meeting?.ownerId === selfId;
	const gridCols = tiles.length <= 1 ? "grid-cols-1" : tiles.length <= 4 ? "grid-cols-2" : "grid-cols-3";

	if (phase === "loading") {
		return <div className="flex h-full items-center justify-center rounded-2xl border border-neutral-200 bg-white text-sm text-neutral-500">{t("meet.loading")}</div>;
	}
	if (phase === "error") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-neutral-200 bg-white">
				<p className="text-sm text-neutral-500">{t("meet.notFound")}</p>
				<Button variant="secondary" onClick={() => router.push("/meet/meetings")}>{t("meet.backToMeetings")}</Button>
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-neutral-200 bg-white">
				<p className="text-sm font-medium text-neutral-900">{t("meet.meetingEnded")}</p>
				<Button variant="secondary" onClick={() => router.push("/meet/meetings")}>{t("meet.backToMeetings")}</Button>
			</div>
		);
	}
	if (phase === "lobby") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-5 rounded-2xl border border-neutral-200 bg-white">
				<h1 className="text-lg font-semibold text-neutral-900">{meeting?.title || t("meet.untitledMeeting")}</h1>
				<div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-neutral-900">
					{localStream && camOn ? (
						<video ref={lobbyVideoRef} autoPlay playsInline muted className="aspect-video w-full object-cover" />
					) : (
						<div className="flex aspect-video w-full items-center justify-center">
							<span className="flex h-20 w-20 items-center justify-center rounded-full bg-[#1a5fd7]/20 text-2xl font-semibold text-white">
								{(user?.name ?? "?").charAt(0).toUpperCase()}
							</span>
						</div>
					)}
					{!localStream && (
						<p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/70">
							{t(mediaIssue === "insecure" ? "meet.mediaInsecure" : mediaIssue === "denied" ? "meet.mediaDenied" : "meet.mediaMissing")}
						</p>
					)}
				</div>
				<div className="flex items-center gap-3">
					<ControlButton active={micOn} onClick={toggleMic} label={micOn ? t("meet.mute") : t("meet.unmute")}>
						{micOn ? <Mic size={18} /> : <MicOff size={18} />}
					</ControlButton>
					<ControlButton active={camOn} onClick={toggleCam} label={camOn ? t("meet.cameraOff") : t("meet.cameraOn")}>
						{camOn ? <Video size={18} /> : <VideoOff size={18} />}
					</ControlButton>
					<Button onClick={() => void join()}>
						{t("meet.joinNow")}
					</Button>
				</div>
			</div>
		);
	}

	// incall
	return (
		<div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950">
			<div className="relative flex min-w-0 flex-1 flex-col">
				<div className={clsx("grid min-h-0 flex-1 gap-2 p-3", gridCols)}>
					{tiles.length === 0 && (
						<div className="col-span-full flex items-center justify-center text-sm text-neutral-400">{t("meet.waitingForOthers")}</div>
					)}
					{tiles.map((tile) => (
						<RemoteVideo key={tile.userId} tile={tile} />
					))}
				</div>
				<div className="pointer-events-none absolute bottom-4 right-4 w-40 overflow-hidden rounded-xl border border-white/20 bg-neutral-900 shadow-xl md:w-56">
					{localStream && camOn ? (
						<video ref={localVideoRef} autoPlay playsInline muted className="aspect-video w-full object-cover" />
					) : (
						<div className="flex aspect-video w-full items-center justify-center">
							<span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1a5fd7]/30 text-lg font-semibold text-white">
								{(user?.name ?? "?").charAt(0).toUpperCase()}
							</span>
						</div>
					)}
				</div>
				<div className="pointer-events-auto absolute inset-x-0 bottom-4 flex justify-center">
					<div className="flex items-center gap-2 rounded-full bg-neutral-900/90 px-4 py-2 shadow-xl">
						<ControlButton active={micOn} onClick={toggleMic} label={micOn ? t("meet.mute") : t("meet.unmute")}>
							{micOn ? <Mic size={18} /> : <MicOff size={18} />}
						</ControlButton>
						<ControlButton active={camOn} onClick={toggleCam} label={camOn ? t("meet.cameraOff") : t("meet.cameraOn")}>
							{camOn ? <Video size={18} /> : <VideoOff size={18} />}
						</ControlButton>
						<ControlButton active={sharing} onClick={() => void toggleShare()} label={sharing ? t("meet.stopShare") : t("meet.shareScreen")}>
							<ScreenShare size={18} />
						</ControlButton>
						<ControlButton
							active={chatOpen}
							onClick={() => { setChatOpen((open) => !open); setUnreadChat(0); }}
							label={t("meet.chat")}
							badge={unreadChat}
						>
							<Chat size={18} />
						</ControlButton>
						{isHost ? (
							<Button
								variant="secondary"
								className="rounded-full bg-red-600 px-4 text-white hover:bg-red-700"
								onClick={() => void meetApi.endMeeting(meetingId).then(() => { teardown(); setPhase("ended"); }).catch(() => undefined)}
							>
								<PhoneOff size={16} className="mr-1.5" />
								{t("meet.endForAll")}
							</Button>
						) : null}
						<Button variant="secondary" className="rounded-full bg-red-600 px-4 text-white hover:bg-red-700" onClick={() => void leave()}>
							<PhoneOff size={16} className="mr-1.5" />
							{t("meet.leave")}
						</Button>
					</div>
				</div>
			</div>
			{chatOpen && meeting?.conversationId && (
				<div className="flex w-80 shrink-0 flex-col border-l border-white/10 bg-white">
					<div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2.5">
						<p className="text-sm font-semibold text-neutral-900">{t("meet.meetingChat")}</p>
						<button type="button" onClick={() => setChatOpen(false)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100" aria-label={t("meet.closeChat")}>
							<X size={16} />
						</button>
					</div>
					<div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
						{chatMessages.map((message) => {
							const own = message.senderId === selfId;
							return (
								<div key={message.id} className={clsx("mb-1.5 flex", own ? "justify-end" : "justify-start")}>
									<div className={clsx("max-w-[85%] rounded-xl px-3 py-1.5", own ? "bg-[#1a5fd7] text-white" : "bg-neutral-100 text-neutral-900")}>
										{!own && <p className="text-[10px] font-semibold text-[#1a5fd7]">{message.senderName}</p>}
										<p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
										<p className={clsx("mt-0.5 text-right text-[10px]", own ? "text-white/60" : "text-neutral-400")}>{timeFormat.format(message.createdAt * 1000)}</p>
									</div>
								</div>
							);
						})}
					</div>
					<div className="flex items-center gap-2 border-t border-neutral-200 p-2">
						<Input
							value={chatDraft}
							onChange={(event) => setChatDraft(event.target.value)}
							onKeyDown={(event) => event.key === "Enter" && void sendChat()}
							placeholder={t("meet.messagePlaceholder")}
							className="h-9 flex-1"
						/>
						<Button size="sm" onClick={() => void sendChat()} disabled={!chatDraft.trim()} aria-label={t("meet.send")}>
							<Send size={14} />
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function RemoteVideo({ tile }: { tile: RemoteTile }) {
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.srcObject = tile.stream;
	}, [tile.stream]);
	return (
		<div className="relative min-h-0 overflow-hidden rounded-xl bg-neutral-900">
			<video ref={ref} autoPlay playsInline className="h-full w-full object-cover" />
			<span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
				{tile.name || "…"}
			</span>
		</div>
	);
}

function ControlButton({
	active,
	onClick,
	label,
	badge,
	children,
}: {
	active?: boolean;
	onClick: () => void;
	label: string;
	badge?: number;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={clsx(
				"relative flex h-10 w-10 items-center justify-center rounded-full transition-colors",
				active ? "bg-white/15 text-white hover:bg-white/25" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700",
			)}
		>
			{children}
			{!!badge && (
				<span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#1a5fd7] px-1 text-[10px] font-bold text-white">
					{badge}
				</span>
			)}
		</button>
	);
}
