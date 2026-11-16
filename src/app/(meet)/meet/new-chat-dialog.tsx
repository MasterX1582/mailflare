"use client";

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Search, Users, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/components/language-provider";
import { meetApi, type MeetUser } from "@/lib/meet/client";

export function NewChatDialog({
	open,
	onClose,
	roster,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	roster: MeetUser[];
	onCreated: (conversationId: string) => void;
}) {
	const { t } = useLanguage();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<MeetUser[]>([]);
	const [groupName, setGroupName] = useState("");
	const [creating, setCreating] = useState(false);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const pool = roster.filter((member) => !selected.some((picked) => picked.id === member.id));
		if (!q) return pool;
		return pool.filter((member) => member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q));
	}, [roster, query, selected]);

	const create = async () => {
		if (!selected.length) return;
		setCreating(true);
		try {
			const input =
				selected.length === 1
					? { kind: "dm" as const, memberIds: [selected[0].id] }
					: { kind: "group" as const, name: groupName.trim() || selected.map((member) => member.name).join(", "), memberIds: selected.map((member) => member.id) };
			const { conversation } = await meetApi.createConversation(input);
			setSelected([]);
			setGroupName("");
			setQuery("");
			onCreated(conversation.id);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("meet.createError"));
		} finally {
			setCreating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(value) => !value && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("meet.newChat")}</DialogTitle>
				</DialogHeader>
				<div className="relative">
					<Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
					<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("meet.searchPeople")} className="pl-9" autoFocus />
				</div>
				{selected.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{selected.map((member) => (
							<span key={member.id} className="flex items-center gap-1 rounded-full bg-[#e8f0fe] px-2.5 py-1 text-xs font-medium text-[#1a5fd7]">
								{member.name}
								<button type="button" onClick={() => setSelected((current) => current.filter((picked) => picked.id !== member.id))} aria-label={t("meet.remove")}>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				{selected.length > 1 && (
					<Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("meet.groupName")} />
				)}
				<div className="max-h-64 overflow-y-auto">
					{filtered.map((member) => (
						<button
							key={member.id}
							type="button"
							onClick={() => setSelected((current) => [...current, member])}
							className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-neutral-50"
						>
							<span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-[#1a5fd7]/10 text-xs font-semibold text-[#1a5fd7]">
								{(member.name || member.email).charAt(0).toUpperCase()}
								{member.online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium text-neutral-900">{member.name || member.email}</span>
								<span className="block truncate text-xs text-neutral-500">{member.email}</span>
							</span>
						</button>
					))}
					{filtered.length === 0 && <p className="py-6 text-center text-sm text-neutral-400">{t("meet.noPeople")}</p>}
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
					<Button onClick={() => void create()} disabled={!selected.length || creating}>
						<Users size={16} className="mr-1" />
						{selected.length > 1 ? t("meet.createGroup") : t("meet.startChat")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
