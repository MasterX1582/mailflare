import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { blockUser, listBlockedUsers, unblockUser } from "@/lib/meet/data";

async function targetUser(db: ReturnType<typeof getDb>, userId: string) {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, userId), eq(users.disabled, false), eq(users.meetEnabled, true)))
		.limit(1);
	return row ?? null;
}

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const db = getDb(env);
	const rows = await listBlockedUsers(db, user!.id);
	return NextResponse.json({
		blocked: rows.map((row) => ({ userId: row.userId, name: row.name, email: row.email })),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { userId?: string };
	if (!input.userId || input.userId === user!.id) {
		return NextResponse.json({ error: "A different user is required" }, { status: 400 });
	}
	const db = getDb(env);
	if (!(await targetUser(db, input.userId))) {
		return NextResponse.json({ error: "User not found" }, { status: 404 });
	}
	await blockUser(db, user!.id, input.userId);
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	const input = (await request.json()) as { userId?: string };
	if (!input.userId) {
		return NextResponse.json({ error: "userId is required" }, { status: 400 });
	}
	const db = getDb(env);
	await unblockUser(db, user!.id, input.userId);
	return NextResponse.json({ ok: true });
}
