"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Video, VideoOff } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import toast from "react-hot-toast";
import { useMeetEvents } from "@/hooks/use-meet-events";
import { meetApi } from "@/lib/meet/client";
import type { MeetCallNotification } from "@/lib/realtime/types";
import { MeetPeerManager } from "@/lib/meet/peer-manager";
import clsx from "clsx";

interface Props {
	meetingId: string;
	callId: string | null;
	mediaKind: "audio" | "video";
	selfId: string;
	otherName: string;
	onClose: () => void;
}

/** Compact 1:1 call strip rendered inside the chat pane — join-on-mount, no lobby. */
export function ChatCallPanel({ meetingId, callId, mediaKind, selfId, otherName, onClose }: Props) {
	const { t } = useLanguage();
	const [status, setStatus] = useState<"connecting" | "ringing" | "live">("connecting");
	const [micOn, setMicOn] = useState(true);
	const [camOn, setCamOn] = useState(mediaKind === "video");
	const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const managerRef = useRef<MeetPeerManager | null>(null);
	const remoteVideoRef = useRef<HTMLVideoElement>(null);
	const remoteAudioRef = useRef<HTMLAudioElement>(null);
	const localVideoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const callIdRef = useRef(callId);
	const closing = useRef(false);

	const close = useCallback(async (endCall: boolean) => {
		if (closing.current) return;
		closing.current = true;
		managerRef.current?.destroy();
		managerRef.current = null;
		streamRef.current?.getTracks().forEach((track) => track.stop());
		streamRef.current = null;
		if (endCall) {
			let id = callIdRef.current;
			if (!id) {
				const { calls } = await meetApi.listMeetings().catch(() => ({ calls: [], meetings: [] }));
				id = calls.find((call) => call.meetingId === meetingId && !call.endedAt)?.id ?? null;
			}
			if (id) await meetApi.updateCall(id, "ended").catch(() => undefined);
		}
		await meetApi.leaveMeeting(meetingId).catch(() => undefined);
		onClose();
	}, [meetingId, onClose]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const stream = typeof navigator.mediaDevices?.getUserMedia === "function"
					? await navigator.mediaDevices.getUserMedia({ video: mediaKind === "video", audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true })).catch(() => null)
					: null;
				if (cancelled) {
					stream?.getTracks().forEach((track) => track.stop());
					return;
				}
				streamRef.current = stream;
				setLocalStream(stream);
				if (!stream) setCamOn(false);
				const { meeting: dto, iceServers } = await meetApi.joinMeeting(meetingId);
				if (cancelled) return;
				const manager = new MeetPeerManager({
					meetingId,
					selfId,
					iceServers,
					sendSignal: (to, payload) => meetApi.sendSignal(meetingId, to, payload),
					onTrack: (_userId, remote) => {
						setRemoteStream(remote);
						setStatus("live");
					},
					onPeerClosed: () => setRemoteStream(null),
				});
				managerRef.current = manager;
				manager.setLocalStream(stream);
				for (const participant of dto.participants) {
					if (participant.userId !== selfId && participant.state === "joined") manager.ensurePeer(participant.userId);
				}
				setStatus((current) => (current === "connecting" ? "ringing" : current));
			} catch (error) {
				if (!cancelled) {
					toast.error(error instanceof Error ? error.message : t("meet.callError"));
					onClose();
				}
			}
		})();
		return () => {
			cancelled = true;
			managerRef.current?.destroy();
			managerRef.current = null;
			streamRef.current?.getTracks().forEach((track) => track.stop());
			streamRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [meetingId]);

	useMeetEvents(
		useCallback(
			(event) => {
				if (event.type === "meet.signal" && event.meetingId === meetingId) {
					void managerRef.current?.handleSignal(event.from, event.payload);
				} else if (event.type === "meet.room" && event.meetingId === meetingId) {
					if (event.event === "peer-joined" && event.userId !== selfId) {
						managerRef.current?.ensurePeer(event.userId);
						setStatus("live");
					} else if (event.event === "peer-left" && event.userId !== selfId) {
						void close(false);
					}
				} else if (event.type === "meet.call") {
					const call = event as MeetCallNotification;
					if (call.meetingId === meetingId && (call.action === "ended" || call.action === "declined" || call.action === "cancelled") && call.from.id !== selfId) {
						void close(false);
					}
				}
			},
			[meetingId, selfId, close],
		),
	);

	useEffect(() => {
		const media = remoteVideoRef.current ?? remoteAudioRef.current;
		if (media && remoteStream) media.srcObject = remoteStream;
	}, [remoteStream, mediaKind]);

	useEffect(() => {
		if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
	}, [localStream]);

	const toggleMic = () =>
		setMicOn((on) => {
			streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = !on));
			return !on;
		});
	const toggleCam = () =>
		setCamOn((on) => {
			streamRef.current?.getVideoTracks().forEach((track) => (track.enabled = !on));
			return !on;
		});

	const control = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode, danger = false) => (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={clsx(
				"flex h-10 w-10 items-center justify-center rounded-full text-white transition",
				danger ? "bg-red-600 hover:bg-red-700" : active ? "bg-white/20 hover:bg-white/30" : "bg-white/5 hover:bg-white/15",
			)}
		>
			{icon}
		</button>
	);

	return (
		<div className="relative flex flex-col overflow-hidden rounded-xl bg-neutral-900">
			<div className={clsx("relative", mediaKind === "video" ? "aspect-video" : "h-36")}>
				{mediaKind === "video" && remoteStream ? (
					<video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
				) : (
					<>
						{remoteStream && <audio ref={remoteAudioRef} autoPlay />}
						<div className="flex h-full flex-col items-center justify-center gap-2">
							<span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1a5fd7]/25 text-xl font-semibold text-white">
								{(otherName || "?").charAt(0).toUpperCase()}
							</span>
							<p className="text-sm font-medium text-white">{otherName}</p>
						</div>
					</>
				)}
				{mediaKind === "video" && !remoteStream && <audio ref={remoteAudioRef} autoPlay />}
				{mediaKind === "video" && localStream && (
					<video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-2 right-2 w-24 rounded-lg border border-white/20 object-cover" />
				)}
				{status !== "live" && (
					<div className="absolute inset-x-0 top-3 text-center">
						<p className="text-xs text-white/70">{status === "connecting" ? t("meet.connecting") : t("meet.calling", { name: otherName })}</p>
					</div>
				)}
			</div>
			<div className="flex items-center justify-center gap-3 py-3">
				{control(micOn, micOn ? t("meet.mute") : t("meet.unmute"), toggleMic, micOn ? <Mic size={16} /> : <MicOff size={16} />)}
				{mediaKind === "video" && control(camOn, camOn ? t("meet.cameraOff") : t("meet.cameraOn"), toggleCam, camOn ? <Video size={16} /> : <VideoOff size={16} />)}
				{control(false, t("meet.hangUp"), () => void close(true), <PhoneOff size={16} />, true)}
			</div>
		</div>
	);
}
