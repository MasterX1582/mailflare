import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/cookies";
import { meetAccessError } from "./data";
import type { SessionUser } from "@/lib/auth/types";

/** requireUser + the per-account Meet feature flag, in the authorize*Request shape other APIs use. */
export async function authorizeMeetRequest(
	env: CloudflareEnv,
	request: Request,
): Promise<{ user: SessionUser | null; error: NextResponse | null }> {
	try {
		const user = await requireUser(env, request);
		const disabled = meetAccessError(user);
		if (disabled) return { user: null, error: NextResponse.json({ error: disabled.error }, { status: disabled.status }) };
		return { user, error: null };
	} catch {
		return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	}
}
