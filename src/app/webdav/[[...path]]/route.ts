import { getEnv } from "@/lib/cloudflare";
import { handleWebdav } from "@/lib/drive/webdav";

async function handle(request: Request) {
	return handleWebdav(request, getEnv());
}

export const OPTIONS = handle;
export const PROPFIND = handle;
export const GET = handle;
export const HEAD = handle;
export const PUT = handle;
export const DELETE = handle;
export const MKCOL = handle;
export const MOVE = handle;
export const COPY = handle;
export const LOCK = handle;
export const UNLOCK = handle;
export const dynamic = "force-dynamic";
