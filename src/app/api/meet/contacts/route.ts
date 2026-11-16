import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { saveManualContact, toContactDetails } from "@/app/api/contacts/utils";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";

// Adds another account user to the caller's Contacts list. The contact lands on
// the caller's first mailbox — mailboxes are per-user here, and contacts are
// keyed by mailbox owner (access.mailbox.userId) in the contacts API.
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { userId?: string };
	if (!input.userId || input.userId === user!.id) {
		return NextResponse.json({ error: "A different user is required" }, { status: 400 });
	}
	const db = getDb(env);
	const [target] = await db
		.select({ email: users.email, name: users.name })
		.from(users)
		.where(and(eq(users.id, input.userId), eq(users.disabled, false), eq(users.meetEnabled, true)))
		.limit(1);
	if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
	const [mailbox] = await db
		.select({ userId: mailboxes.userId })
		.from(mailboxes)
		.where(eq(mailboxes.userId, user!.id))
		.limit(1);
	if (!mailbox) return NextResponse.json({ error: "No mailbox available for contacts" }, { status: 400 });
	const saved = await saveManualContact(db, {
		userId: mailbox.userId,
		email: target.email,
		displayName: target.name,
	});
	return NextResponse.json({ contact: toContactDetails(saved) });
}
