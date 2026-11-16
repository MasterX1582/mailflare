import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { getUserFromSession } from "@/lib/auth/session";
import { newId } from "@/lib/ids";
import { streamDriveFile } from "./content";
import { getDriveStorageLimit, getDriveStorageUsed } from "./storage";
import { DRIVE_MAX_DEPTH, DRIVE_MAX_FILE_BYTES, driveObjectKey, normalizeDriveName } from "./utils";
import type { DriveRow } from "./types";

/**
 * WebDAV endpoint for Drive: mount a user's My Drive root as a network drive
 * (Windows Explorer, macOS Finder, davfs, Cyberduck, rclone...). Auth is HTTP
 * Basic with the account's email and password, or a Bearer session token.
 * Everything goes through env.BUCKET and the drive_items table, so files stay
 * identical to what the Drive UI sees; deletes land in Drive trash.
 */

type DriveDb = ReturnType<typeof getDb>;
type DriveUser = typeof users.$inferSelect;

const DAV_PREFIX = "/webdav";
const DAV_METHODS = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK";

// ---------- auth ----------

async function authenticate(env: CloudflareEnv, request: Request): Promise<DriveUser | "limited" | null> {
	const authorization = request.headers.get("Authorization");
	if (!authorization) return null;
	if (authorization.toLowerCase().startsWith("basic ")) {
		let decoded: string;
		try {
			decoded = atob(authorization.slice(6).trim());
		} catch {
			return null;
		}
		const separator = decoded.indexOf(":");
		if (separator < 0) return null;
		const email = decoded.slice(0, separator).toLowerCase().trim();
		const password = decoded.slice(separator + 1);
		if (!email || !password) return null;
		const db = getDb(env);
		// Consume Basic-auth budget BEFORE the bcrypt compare — an exhausted
		// budget must reject without paying the ~100ms hash cost (event-loop DoS).
		try {
			const client = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-mailflare-client-ip") ?? "local";
			const result = await env.LOGIN_RATE_LIMIT?.limit({ key: `webdav-basic:${client}:${email}` });
			if (result && !result.success) return "limited";
		} catch {}
		const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
		if (user && !user.disabled && verifyPassword(password, user.passwordHash)) return user;
		return null;
	}
	if (authorization.startsWith("Bearer ")) {
		const user = await getUserFromSession(env, authorization.slice(7).trim());
		return user && !user.disabled ? user : null;
	}
	return null;
}

function unauthorized(): Response {
	return new Response("Authentication required", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="Mailflare Drive"' },
	});
}

// ---------- paths ----------

function decodePathname(pathname: string): string[] | null {
	if (!pathname.startsWith(DAV_PREFIX)) return null;
	const rest = pathname.slice(DAV_PREFIX.length).replace(/^\/+|\/+$/g, "");
	if (!rest) return [];
	const segments: string[] = [];
	for (const raw of rest.split("/")) {
		let segment = raw;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			// keep the raw segment; some names legitimately contain '%'
		}
		if (!segment || segment === "." || segment === ".." || segment.includes("\\")) return null;
		segments.push(segment);
	}
	return segments.length > DRIVE_MAX_DEPTH ? null : segments;
}

function destinationSegments(request: Request): string[] | null {
	const destination = request.headers.get("Destination");
	if (!destination) return null;
	let pathname: string;
	try {
		pathname = new URL(destination, request.url).pathname;
	} catch {
		return null;
	}
	return decodePathname(pathname);
}

// ---------- drive lookups ----------

async function listChildren(db: DriveDb, parentId: string | null, ownerId: string): Promise<DriveRow[]> {
	return db
		.select()
		.from(driveItems)
		.where(and(parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId), eq(driveItems.ownerId, ownerId), isNull(driveItems.trashedAt), isNull(driveItems.uploadId)));
}

async function lookupChild(db: DriveDb, parentId: string | null, ownerId: string, name: string): Promise<DriveRow | null> {
	const [row] = await db
		.select()
		.from(driveItems)
		.where(
			and(
				parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId),
				eq(driveItems.ownerId, ownerId),
				isNull(driveItems.trashedAt),
				isNull(driveItems.uploadId),
				sql`lower(${driveItems.name}) = ${name.toLowerCase()}`,
			),
		)
		.limit(1);
	return row ?? null;
}

/** Walks the name chain from the user's root. Returns [] for the root, null when any segment misses. */
async function resolveChain(db: DriveDb, ownerId: string, segments: string[]): Promise<DriveRow[] | null> {
	const chain: DriveRow[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < segments.length; index++) {
		const child = await lookupChild(db, parentId, ownerId, segments[index]);
		if (!child) return null;
		chain.push(child);
		if (child.kind !== "folder" && index < segments.length - 1) return null;
		parentId = child.id;
	}
	return chain;
}

// ---------- XML ----------

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hrefFor(segments: string[], folder: boolean): string {
	const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
	const href = encoded ? `${DAV_PREFIX}/${encoded}` : `${DAV_PREFIX}/`;
	return folder && !href.endsWith("/") ? `${href}/` : href;
}

function responseXml(href: string, item: DriveRow | null): string {
	const folder = !item || item.kind === "folder";
	const name = item ? item.name : "";
	const modified = (item?.updatedAt ?? new Date()).toUTCString();
	const created = (item?.createdAt ?? new Date()).toISOString();
	const props = [
		`<D:displayname>${escapeXml(name)}</D:displayname>`,
		`<D:resourcetype>${folder ? "<D:collection/>" : ""}</D:resourcetype>`,
		`<D:getlastmodified>${modified}</D:getlastmodified>`,
		`<D:creationdate>${created}</D:creationdate>`,
		folder ? "" : `<D:getcontentlength>${item!.size}</D:getcontentlength>`,
		folder ? "" : `<D:getcontenttype>${escapeXml(item!.contentType)}</D:getcontenttype>`,
		item ? `<D:getetag>"${item.id}-${item.updatedAt.getTime().toString(36)}-${item.size.toString(36)}"</D:getetag>` : "",
	].join("");
	return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(bodies: string[]): Response {
	const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${bodies.join("")}</D:multistatus>`;
	return new Response(xml, { status: 207, headers: { "Content-Type": "application/xml; charset=utf-8" } });
}

// ---------- method handlers ----------

async function handlePropfind(db: DriveDb, user: DriveUser, segments: string[], request: Request): Promise<Response> {
	const depth = request.headers.get("Depth") ?? "1";
	if (depth === "infinity") return new Response("PROPFIND with infinite depth is not supported", { status: 403 });
	const chain = await resolveChain(db, user.id, segments);
	if (!chain) return new Response("Not found", { status: 404 });
	const item = chain[chain.length - 1] ?? null;
	const bodies = [responseXml(hrefFor(segments, !item || item.kind === "folder"), item)];
	if (depth === "1" && (!item || item.kind === "folder")) {
		const parentId = item?.id ?? null;
		const ownerId = item?.ownerId ?? user.id;
		for (const child of await listChildren(db, parentId, ownerId)) {
			bodies.push(responseXml(hrefFor([...segments, child.name], child.kind === "folder"), child));
		}
	}
	return multistatus(bodies);
}

async function handleGet(env: CloudflareEnv, db: DriveDb, user: DriveUser, segments: string[], request: Request): Promise<Response> {
	const chain = await resolveChain(db, user.id, segments);
	const item = chain?.[chain.length - 1];
	if (!item || item.kind !== "file") return new Response("Not found", { status: 404 });
	return streamDriveFile(env, request, item, false);
}

async function putBody(env: CloudflareEnv, key: string, request: Request, contentType: string): Promise<number> {
	const length = Number(request.headers.get("content-length") ?? NaN);
	if (Number.isFinite(length) && request.body) {
		await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } });
		return length;
	}
	const buffer = await request.arrayBuffer();
	if (buffer.byteLength > DRIVE_MAX_FILE_BYTES) return -1;
	await env.BUCKET.put(key, buffer, { httpMetadata: { contentType } });
	return buffer.byteLength;
}

async function handlePut(env: CloudflareEnv, db: DriveDb, user: DriveUser, segments: string[], request: Request): Promise<Response> {
	if (!segments.length) return new Response("Cannot write to the drive root", { status: 405 });
	const name = normalizeDriveName(segments[segments.length - 1]);
	if (!name) return new Response("Invalid name", { status: 400 });
	const parentChain = await resolveChain(db, user.id, segments.slice(0, -1));
	if (!parentChain) return new Response("Parent folder not found", { status: 409 });
	const parent = parentChain[parentChain.length - 1] ?? null;
	if (parent && parent.kind !== "folder") return new Response("Parent is not a folder", { status: 409 });
	const ownerId = parent?.ownerId ?? user.id;
	const existing = await lookupChild(db, parent?.id ?? null, ownerId, name);
	if (existing?.kind === "folder") return new Response("A folder with that name exists", { status: 405 });

	const contentType = request.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
	const declared = Number(request.headers.get("content-length") ?? 0);
	const limit = await getDriveStorageLimit(env);
	const overLimit = async (size: number) => limit !== null && (await getDriveStorageUsed(db, ownerId)) - (existing?.size ?? 0) + size > limit;
	if (declared > DRIVE_MAX_FILE_BYTES || (declared > 0 && (await overLimit(declared)))) {
		return new Response(declared > DRIVE_MAX_FILE_BYTES ? "File is too large" : "Not enough Drive storage left for this file", { status: 413 });
	}
	const id = existing?.id ?? newId("drv");
	// Overwrites land on a fresh key so a rejected upload never orphans blob bytes
	// outside quota accounting and never destroys the still-referenced old blob.
	const key = existing ? driveObjectKey(ownerId, newId("drv")) : driveObjectKey(ownerId, id);
	const size = await putBody(env, key, request, contentType);
	const tooBig = size < 0 || size > DRIVE_MAX_FILE_BYTES;
	if (tooBig || (await overLimit(size))) {
		await env.BUCKET.delete(key).catch(() => undefined);
		return new Response(tooBig ? "File is too large" : "Not enough Drive storage left for this file", { status: 413 });
	}
	const now = new Date();
	if (existing) {
		await env.BUCKET.delete(existing.r2Key ?? "").catch(() => undefined);
		await db.update(driveItems).set({ r2Key: key, size, contentType, updatedAt: now }).where(eq(driveItems.id, existing.id));
		return new Response(null, { status: 204 });
	}
	await db.insert(driveItems).values({
		id,
		ownerId,
		parentId: parent?.id ?? null,
		kind: "file",
		name,
		r2Key: key,
		size,
		contentType,
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		linkToken: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	});
	return new Response(null, { status: 201 });
}

async function handleMkcol(db: DriveDb, user: DriveUser, segments: string[]): Promise<Response> {
	if (!segments.length) return new Response("Cannot create the drive root", { status: 405 });
	const name = normalizeDriveName(segments[segments.length - 1]);
	if (!name) return new Response("Invalid name", { status: 400 });
	const parentChain = await resolveChain(db, user.id, segments.slice(0, -1));
	if (!parentChain) return new Response("Parent folder not found", { status: 409 });
	const parent = parentChain[parentChain.length - 1] ?? null;
	if (parent && parent.kind !== "folder") return new Response("Parent is not a folder", { status: 409 });
	const ownerId = parent?.ownerId ?? user.id;
	if (await lookupChild(db, parent?.id ?? null, ownerId, name)) {
		return new Response("An item with that name already exists", { status: 405 });
	}
	const now = new Date();
	await db.insert(driveItems).values({
		id: newId("drv"),
		ownerId,
		parentId: parent?.id ?? null,
		kind: "folder",
		name,
		r2Key: null,
		size: 0,
		contentType: "application/x-directory",
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		linkToken: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	});
	return new Response(null, { status: 201 });
}

async function handleDelete(env: CloudflareEnv, db: DriveDb, user: DriveUser, segments: string[]): Promise<Response> {
	const chain = await resolveChain(db, user.id, segments);
	const item = chain?.[chain.length - 1];
	if (!item) return new Response("Not found", { status: 404 });
	// Same semantics as the Drive UI: DELETE moves to trash rather than erasing.
	await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, item.id));
	return new Response(null, { status: 204 });
}

/** Resolves the destination's parent and the remaining item name; trashes an existing target when Overwrite allows. */
async function prepareDestination(
	env: CloudflareEnv,
	db: DriveDb,
	user: DriveUser,
	request: Request,
): Promise<{ parentId: string | null; ownerId: string; name: string; existing: DriveRow | null } | Response> {
	const segments = destinationSegments(request);
	if (!segments || !segments.length) return new Response("Bad or missing Destination header", { status: 400 });
	const name = normalizeDriveName(segments[segments.length - 1]);
	if (!name) return new Response("Invalid destination name", { status: 400 });
	const parentChain = await resolveChain(db, user.id, segments.slice(0, -1));
	if (!parentChain) return new Response("Destination parent folder not found", { status: 409 });
	const parent = parentChain[parentChain.length - 1] ?? null;
	if (parent && parent.kind !== "folder") return new Response("Destination parent is not a folder", { status: 409 });
	const ownerId = parent?.ownerId ?? user.id;
	const existing = await lookupChild(db, parent?.id ?? null, ownerId, name);
	if (request.headers.get("Overwrite") === "F" && existing) {
		return new Response("Destination exists and Overwrite is F", { status: 412 });
	}
	// The caller trashes the destination only after its own checks pass, so a rejected MOVE/COPY cannot delete it.
	return { parentId: parent?.id ?? null, ownerId, name, existing };
}

async function handleMove(env: CloudflareEnv, db: DriveDb, user: DriveUser, segments: string[], request: Request): Promise<Response> {
	const chain = await resolveChain(db, user.id, segments);
	const item = chain?.[chain.length - 1];
	if (!item) return new Response("Not found", { status: 404 });
	const destination = await prepareDestination(env, db, user, request);
	if (destination instanceof Response) return destination;
	if (await destinationInsideItem(db, item, destination.parentId)) return new Response("A folder cannot move into itself or anything beneath it", { status: 409 });
	if (destination.existing) await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, destination.existing.id));
	await db.update(driveItems).set({ name: destination.name, parentId: destination.parentId, updatedAt: new Date() }).where(eq(driveItems.id, item.id));
	return new Response(null, { status: destination.existing ? 204 : 201 });
}

/** True when parentId sits inside the item's own subtree (MOVE/COPY into self). */
async function destinationInsideItem(db: DriveDb, item: DriveRow, parentId: string | null): Promise<boolean> {
	if (item.kind !== "folder") return false;
	let ancestor = parentId;
	for (let depth = 0; ancestor && depth <= DRIVE_MAX_DEPTH; depth += 1) {
		if (ancestor === item.id) return true;
		const [row] = await db.select({ parentId: driveItems.parentId }).from(driveItems).where(eq(driveItems.id, ancestor)).limit(1);
		ancestor = row?.parentId ?? null;
	}
	return false;
}

/** Total bytes a COPY of this subtree would add, capped early to bound the walk. */
async function subtreeSize(db: DriveDb, item: DriveRow): Promise<number> {
	let total = item.size;
	if (item.kind === "folder") {
		for (const child of await listChildren(db, item.id, item.ownerId)) {
			total += await subtreeSize(db, child);
			if (total > DRIVE_MAX_FILE_BYTES) return total;
		}
	}
	return total;
}

async function copyItemTree(env: CloudflareEnv, db: DriveDb, source: DriveRow, parentId: string | null, name: string, ownerId: string): Promise<void> {
	const id = newId("drv");
	const now = new Date();
	let r2Key: string | null = null;
	if (source.kind === "file") {
		r2Key = driveObjectKey(ownerId, id);
		const object = await env.BUCKET.get(source.r2Key ?? driveObjectKey(source.ownerId, source.id));
		if (!object) throw new Error("Stored file content is missing");
		await env.BUCKET.put(r2Key, object.body, { httpMetadata: { contentType: source.contentType } });
	}
	await db.insert(driveItems).values({
		id,
		ownerId,
		parentId,
		kind: source.kind,
		name,
		r2Key,
		size: source.size,
		contentType: source.contentType,
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		linkToken: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	});
	if (source.kind === "folder") {
		for (const child of await listChildren(db, source.id, source.ownerId)) {
			await copyItemTree(env, db, child, id, child.name, ownerId);
		}
	}
}

async function handleCopy(env: CloudflareEnv, db: DriveDb, user: DriveUser, segments: string[], request: Request): Promise<Response> {
	const chain = await resolveChain(db, user.id, segments);
	const item = chain?.[chain.length - 1];
	if (!item) return new Response("Not found", { status: 404 });
	const destination = await prepareDestination(env, db, user, request);
	if (destination instanceof Response) return destination;
	if (await destinationInsideItem(db, item, destination.parentId)) return new Response("A folder cannot be copied into itself or anything beneath it", { status: 409 });
	const limit = await getDriveStorageLimit(env);
	if (limit !== null && (await getDriveStorageUsed(db, destination.ownerId)) + (await subtreeSize(db, item)) > limit) {
		return new Response("Not enough Drive storage left for this copy", { status: 413 });
	}
	if (destination.existing) await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, destination.existing.id));
	if (item.kind === "folder" && request.headers.get("Depth") === "0") {
		const now = new Date();
		await db.insert(driveItems).values({
			id: newId("drv"), ownerId: destination.ownerId, parentId: destination.parentId, kind: "folder", name: destination.name,
			r2Key: null, size: 0, contentType: "application/x-directory", uploadId: null, uploadPartSize: null,
			uploadFingerprint: null, linkToken: null, trashedAt: null, createdAt: now, updatedAt: now,
		});
	} else {
		await copyItemTree(env, db, item, destination.parentId, destination.name, destination.ownerId);
	}
	return new Response(null, { status: destination.existing ? 204 : 201 });
}

function handleLock(): Response {
	const token = `opaquelocktoken:${crypto.randomUUID()}`;
	const xml = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
	return new Response(xml, {
		status: 200,
		headers: { "Content-Type": "application/xml; charset=utf-8", "Lock-Token": `<${token}>` },
	});
}

// ---------- entrypoint ----------

export async function handleWebdav(request: Request, env: CloudflareEnv): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, {
			status: 200,
			headers: { DAV: "1, 2", "MS-Author-Via": "DAV", Allow: DAV_METHODS, "Content-Length": "0" },
		});
	}
	const user = await authenticate(env, request);
	if (user === "limited") return new Response("Too many authentication attempts", { status: 429 });
	if (!user) return unauthorized();
	if (!user.driveEnabled) return new Response("Drive is disabled for this account", { status: 403 });

	const segments = decodePathname(new URL(request.url).pathname);
	if (segments === null) return new Response("Bad path", { status: 400 });
	const db = getDb(env);

	switch (request.method) {
		case "PROPFIND":
			return handlePropfind(db, user, segments, request);
		case "GET":
		case "HEAD":
			return handleGet(env, db, user, segments, request);
		case "PUT":
			return handlePut(env, db, user, segments, request);
		case "MKCOL":
			return handleMkcol(db, user, segments);
		case "DELETE":
			return handleDelete(env, db, user, segments);
		case "MOVE":
			return handleMove(env, db, user, segments, request);
		case "COPY":
			return handleCopy(env, db, user, segments, request);
		case "LOCK":
			return handleLock();
		case "UNLOCK":
			return new Response(null, { status: 204 });
		default:
			return new Response("Method not allowed", { status: 405, headers: { Allow: DAV_METHODS } });
	}
}