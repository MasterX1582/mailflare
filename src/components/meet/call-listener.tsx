"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, PhoneOff, Video } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { meetApi } from "@/lib/meet/client";
import { meetSocket } from "@/lib/meet/socket";
import type { MeetCallNotification } from "@/lib/realtime/types";

interface IncomingCall {
	callId: string;
	meetingId: string;
	from: { id: string; name: string };
	mediaKind: "audio" | "video";
	title: string;
}

const RING_TIMEOUT_MS = 45_000;

/**
 * App-wide incoming-call surface: rings on `meet.call` events wherever the
 * user is, answers by routing into the call view. Mounted once inside
 * AuthGuard so it covers every signed-in page.
 */
export function MeetCallListener() {
	const { t } = useLanguage();
	const router = useRouter();
	const [incoming, setIncoming] = useState<IncomingCall | null>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clear = useCallback(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = null;
		setIncoming(null);
	}, []);

	useEffect(
		() =>
			meetSocket.subscribe((event) => {
				if (event.type !== "meet.call") return;
				const call = event as MeetCallNotification;
				if (call.action === "ringing") {
					setIncoming({ callId: call.callId, meetingId: call.meetingId, from: call.from, mediaKind: call.mediaKind, title: call.title });
					if (timeoutRef.current) clearTimeout(timeoutRef.current);
					timeoutRef.current = setTimeout(() => setIncoming(null), RING_TIMEOUT_MS);
				} else if ((call.action === "cancelled" || call.action === "ended" || call.action === "answered") && incoming?.callId === call.callId) {
					clear();
				}
			}),
		[incoming?.callId, clear],
	);

	useEffect(() => clear, [clear]);

	if (!incoming) return null;

	const decline = async () => {
		await meetApi.updateCall(incoming.callId, "declined", incoming.from.id).catch(() => undefined);
		clear();
	};

	const answer = async () => {
		const call = incoming;
		clear();
		// 1:1 calls open inside the conversation; group/instant calls use the meeting view.
		const { meeting } = await meetApi.getMeeting(call.meetingId).catch(() => ({ meeting: null, invited: false }));
		if (meeting?.kind === "dm" && meeting.conversationId) {
			// Also dispatch for the case where the callee is already on this chat page (no remount).
			window.dispatchEvent(new CustomEvent("meet:accept-call", { detail: { meetingId: call.meetingId, conversationId: meeting.conversationId, mediaKind: call.mediaKind } }));
			router.push(`/meet/chat/${meeting.conversationId}?call=${call.meetingId}&media=${call.mediaKind}`);
		} else {
			router.push(`/meet/call/${call.meetingId}?media=${call.mediaKind}`);
		}
	};

	return (
		<div className="fixed bottom-6 right-6 z-[100] w-80 rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl shadow-neutral-900/20">
			<div className="flex items-center gap-3">
				<span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1a5fd7]/10 text-lg font-semibold text-[#1a5fd7]">
					{(incoming.from.name || "?").charAt(0).toUpperCase()}
					<span className="absolute inset-0 animate-ping rounded-full bg-[#1a5fd7]/20" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-semibold text-neutral-900">{incoming.from.name}</p>
					<p className="text-xs text-neutral-500">
						{incoming.mediaKind === "audio" ? t("meet.incomingAudio") : t("meet.incomingVideo")}
					</p>
				</div>
			</div>
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					onClick={() => void decline()}
					className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-red-600 text-sm font-medium text-white hover:bg-red-700"
				>
					<PhoneOff size={15} />
					{t("meet.decline")}
				</button>
				<button
					type="button"
					onClick={answer}
					className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700"
				>
					{incoming.mediaKind === "audio" ? <Phone size={15} /> : <Video size={15} />}
					{t("meet.answer")}
				</button>
			</div>
		</div>
	);
}
