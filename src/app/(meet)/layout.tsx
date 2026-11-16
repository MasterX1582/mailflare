"use client";

import { SkipToContent } from "@/components/skip-to-content";
import { Suspense } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { LicenseIndicator } from "@/components/license-indicator";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { SidebarAside, MobileMenuButton } from "@/components/sidebar-aside";
import { SidebarHeader } from "@/components/sidebar-header";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { SidebarProvider, useSidebar } from "@/components/sidebar-state";
import { ShortcutsProvider } from "@/components/shortcuts";
import { RouteTitle } from "@/components/route-title";
import { MeetNav } from "./meet-nav";

function MeetFrame({ children }: { children: React.ReactNode }) {
	const { mobile, toggle } = useSidebar();
	return (
		<div className="grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]" style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
			<SkipToContent />
			<SidebarAside>
				<div className="flex h-full min-h-0 flex-col">
					<div className="shrink-0 px-3 pt-4"><SidebarHeader href="/meet/chat" /></div>
					<Suspense fallback={null}><MeetNav onNavigate={mobile ? toggle : undefined} /></Suspense>
				</div>
				<SidebarResizeBoundary />
			</SidebarAside>
			<div className="flex min-h-0 min-w-0 flex-col">
				<header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
					<MobileMenuButton className="ml-2" />
					<div id="meet-header-slot" className="flex min-w-0 flex-1 items-center" />
					<LicenseIndicator />
					<MailboxSelector />
				</header>
				<main id="main-content" tabIndex={-1} className="focus:outline-none min-h-0 min-w-0 flex-1 overflow-hidden md:pr-4">{children}</main>
			</div>
		</div>
	);
}

export default function MeetLayout({ children }: { children: React.ReactNode }) {
	return (
		<AuthGuard requireFeature="meet">
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<MailSearchProvider>
							<ShortcutsProvider>
								<RouteTitle />
								<MeetFrame>{children}</MeetFrame>
							</ShortcutsProvider>
						</MailSearchProvider>
					</ComposeProvider>
				</MailboxProvider>
			</SidebarProvider>
		</AuthGuard>
	);
}
