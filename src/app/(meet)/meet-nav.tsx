"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Chat, Video } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { PoweredBy } from "@/components/sidebar-footer";
import { useSidebar } from "@/components/sidebar-state";

export function MeetNav({ onNavigate }: { onNavigate?: () => void }) {
	const { t } = useLanguage();
	const { minimal, mobile } = useSidebar();
	const pathname = usePathname();
	const compact = minimal && !mobile;

	const items = [
		{ href: "/meet/chat", label: t("meet.chat"), icon: Chat, active: pathname.startsWith("/meet/chat") },
		{ href: "/meet/meetings", label: t("meet.meetings"), icon: Video, active: pathname.startsWith("/meet/meetings") || pathname.startsWith("/meet/call") },
	];

	return (
		<nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4 pt-2">
			{items.map(({ href, label, icon: Icon, active }) => (
				<Link
					key={href}
					href={href}
					onClick={onNavigate}
					className={clsx(
						"flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
						active ? "bg-[#e8f0fe] text-[#1a5fd7]" : "text-neutral-700 hover:bg-neutral-200/60",
						compact && "justify-center px-0",
					)}
				>
					<Icon size={18} className="shrink-0" />
					{!compact && label}
				</Link>
			))}
			<div className="mt-auto pt-4">
				<PoweredBy />
			</div>
		</nav>
	);
}
