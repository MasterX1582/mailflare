"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { CalendarDays, Chat, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Users, Video } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/components/language-provider";
import { meetApi, type MeetCallLog, type MeetMeetingDto } from "@/lib/meet/client";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function formatDuration(startedAt: number, endedAt: number | null): string {
	const end = endedAt ?? Math.floor(Date.now() / 1000);
	const seconds = Math.max(0, end - startedAt);
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function MeetMeetingsView() {
	const { t } = useLanguage();
	const router = useRouter();
	const [meetings, setMeetings] = useState<MeetMeetingDto[]>([]);
	const [calls, setCalls] = useState<MeetCallLog[]>([]);
	const [code, setCode] = useState("");
	const [creating, setCreating] = useState(false);
	const [joining, setJoining] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void meetApi.listMeetings()
			.then((data) => {
				if (cancelled) return;
				setMeetings(data.meetings);
				setCalls(data.calls);
			})
			.catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : t("meet.loadError")); });
		return () => { cancelled = true; };
	}, [t]);

	const startInstant = async () => {
		setCreating(true);
		try {
			const { meeting } = await meetApi.createMeeting({ kind: "instant" });
			router.push(`/meet/call/${meeting.id}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.createError"));
		} finally {
			setCreating(false);
		}
	};

	const joinHref = (meeting: MeetMeetingDto) => {
		const openCall = calls.find((call) => call.meetingId === meeting.id && !call.endedAt);
		return `/meet/call/${meeting.id}${openCall ? `?media=${openCall.mediaKind}` : ""}`;
	};

	const joinByCode = async () => {
		const trimmed = code.trim();
		if (!trimmed) return;
		setJoining(true);
		try {
			const { meeting } = await meetApi.joinByCode(trimmed);
			router.push(`/meet/call/${meeting.id}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.notFound"));
		} finally {
			setJoining(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6">
			<div className="flex flex-wrap items-center gap-3">
				<Button onClick={() => void startInstant()} disabled={creating}>
					<Video size={16} className="mr-1.5" />
					{t("meet.newMeeting")}
				</Button>
				<div className="flex items-center gap-2">
					<Input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && void joinByCode()}
						placeholder={t("meet.enterCode")}
						className="w-48"
					/>
					<Button variant="secondary" onClick={() => void joinByCode()} disabled={joining || !code.trim()}>
						{t("meet.join")}
					</Button>
				</div>
			</div>

			<section>
				<h2 className="mb-3 text-sm font-semibold text-neutral-900">{t("meet.upcoming")}</h2>
				{meetings.length === 0 ? (
					<p className="rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">{t("meet.noMeetings")}</p>
				) : (
					<div className="space-y-2">
						{meetings.map((meeting) => {
							const live = meeting.status === "live";
							return (
								<div key={meeting.id} className="flex items-center gap-4 rounded-xl border border-neutral-200 px-4 py-3">
									<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1a5fd7]/10 text-[#1a5fd7]">
										{live ? <Video size={18} /> : <CalendarDays size={18} />}
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium text-neutral-900">{meeting.title || t("meet.untitledMeeting")}</p>
										<p className="text-xs text-neutral-500">
											{live
												? t("meet.liveNow")
												: meeting.scheduledStartAt
													? dateTimeFormat.format(meeting.scheduledStartAt * 1000)
													: t("meet.instantMeeting")}
											{" · "}
											<Users size={11} className="mr-0.5 inline" />
											{meeting.participants.length}
											{" · "}
											{t("meet.codeLabel")} {meeting.code}
										</p>
									</div>
									<Button size="sm" variant={live ? "default" : "secondary"} onClick={() => router.push(joinHref(meeting))}>
										{t("meet.join")}
									</Button>
									{meeting.conversationId && (
										<Button size="sm" variant="secondary" onClick={() => router.push(`/meet/chat/${meeting.conversationId}`)} aria-label={t("meet.openChat")}>
											<Chat size={14} />
										</Button>
									)}
								</div>
							);
						})}
					</div>
				)}
			</section>

			<section>
				<h2 className="mb-3 text-sm font-semibold text-neutral-900">{t("meet.callHistory")}</h2>
				{calls.length === 0 ? (
					<p className="rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">{t("meet.noCalls")}</p>
				) : (
					<div className="space-y-1">
						{calls.map((call) => {
							const missed = call.endReason === "missed" || call.endReason === "declined" || (!call.answeredAt && call.endReason !== null);
							const Icon = missed ? PhoneMissed : call.mediaKind === "audio" ? Phone : Video;
							return (
								<div key={call.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-50">
									<span className={missed ? "text-red-500" : "text-neutral-400"}>
										<Icon size={16} />
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm text-neutral-900">{call.meetingTitle || call.initiatorName}</p>
										<p className="text-xs text-neutral-500">
											{dateTimeFormat.format(call.startedAt * 1000)}
											{call.endReason === "missed" && ` · ${t("meet.missed")}`}
											{call.endReason === "declined" && ` · ${t("meet.declined")}`}
											{call.endReason === "cancelled" && ` · ${t("meet.cancelled")}`}
											{call.answeredAt && ` · ${formatDuration(call.answeredAt, call.endedAt)}`}
										</p>
									</div>
									{missed ? <PhoneIncoming size={14} className="text-red-400" /> : <PhoneOutgoing size={14} className="text-neutral-300" />}
								</div>
							);
						})}
					</div>
				)}
			</section>
		</div>
	);
}
