import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";

const ONLINE_WINDOW_SECONDS = 90;

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const db = getDb(env);
	const rows = await db
		.select({ id: users.id, name: users.name, email: users.email, avatarKey: users.avatarKey, lastSeenAt: users.lastSeenAt })
		.from(users)
		.where(and(ne(users.id, user!.id), eq(users.disabled, false), eq(users.meetEnabled, true)));
	const now = Math.floor(Date.now() / 1000);
	return NextResponse.json({
		users: rows.map((row) => {
			const lastSeenAt = row.lastSeenAt ? Math.floor(new Date(row.lastSeenAt).getTime() / 1000) : null;
			return { id: row.id, name: row.name, email: row.email, avatarKey: row.avatarKey, lastSeenAt, online: lastSeenAt !== null && now - lastSeenAt < ONLINE_WINDOW_SECONDS };
		}),
	});
}
