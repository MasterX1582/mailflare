import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeMeetRequest } from "@/lib/meet/api-auth";
import { iceServers } from "@/lib/meet/data";

export async function GET(request: Request) {
	const env = getEnv();
	const { error } = await authorizeMeetRequest(env, request);
	if (error) return error;
	return NextResponse.json({ iceServers: await iceServers(env) });
}
