import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { getUserFromSession } from "@/lib/auth/session";
import { getSessionTokenFromRequest } from "@/lib/realtime/utils";
import { processInboundMessage } from "@/lib/email/inbound";
import { processAgentDraftJob } from "@/lib/agent/jobs/utils";
import { processOutboundQueue, type OutboundQueueMessage } from "@/lib/email/send";
import { processWebhookRetry, type WebhookRetryMessage } from "@/lib/email/webhooks";
import { processImportJob } from "@/lib/import/jobs";
import { applyPendingMigrations } from "@/lib/migrations/service";
import { isImportJobMessage, isInboundQueueMessage, isWebhookRetryMessage } from "../worker-utils";
import { createNodeRuntime } from "./runtime/env";
import { applyMigrations } from "./runtime/migrate";
import { startScheduler } from "./runtime/scheduler";
import { startSmtpListener } from "./runtime/smtp";
import { handleWebdav } from "@/lib/drive/webdav";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** WebDAV methods Next cannot route; GET/PUT/DELETE/HEAD use the route handler like everything else. */
const WEBDAV_EDGE_METHODS = new Set(["OPTIONS", "PROPFIND", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK"]);

/**
 * The self-hosted entrypoint: one Node process serving the Next app, the
 * realtime WebSocket, the SMTP listener, the job queues and the backup
 * schedule, the same jobs worker.ts spreads across Cloudflare products.
 */
async function main() {
	const port = Number(process.env.PORT ?? 3000);
	const host = process.env.HOST ?? "0.0.0.0";
	const dev = process.env.NODE_ENV !== "production";
	const runtime = createNodeRuntime();
	const { env } = runtime;
	globalThis.__mailflareNodeEnv = env;

	const migrated = runtime.database
		? await applyMigrations(runtime.database, resolve(process.env.MIGRATIONS_DIR ?? join(process.cwd(), "drizzle", "migrations")))
		: (await applyPendingMigrations(env.DB)).applied;
	if (migrated.length) console.log(`Applied ${migrated.length} migration(s): ${migrated.join(", ")}`);

	runtime.inboundQueue.setConsumer(async (body) => {
		if (isInboundQueueMessage(body)) await processInboundMessage(env, body);
	});
	runtime.outboundQueue.setConsumer(async (body) => {
		if (isWebhookRetryMessage(body)) await processWebhookRetry(env, body as WebhookRetryMessage);
		else if (isImportJobMessage(body)) await processImportJob(env, body);
		else await processOutboundQueue(env, body as OutboundQueueMessage);
	});
	runtime.agentQueue.setConsumer(async (body) => {
		if (typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "agent.draft" && typeof (body as { jobId?: unknown }).jobId === "string") await processAgentDraftJob(env, (body as { jobId: string }).jobId);
	});

	const app = next({ dev, dir: process.cwd(), hostname: host, port });
	const handle = app.getRequestHandler();
	await app.prepare();

	// Set TRUST_PROXY=1 when a reverse proxy terminates in front of this
	// process; the client IP it appended to x-forwarded-for is then trusted.
	// Direct exposure must leave it unset so only the socket IP is trusted.
	const trustProxy = ["1", "true", "yes"].includes((process.env.TRUST_PROXY ?? "").toLowerCase());

	// Next.js route handlers only dispatch the standard verbs, so WebDAV's own
	// methods are bridged to the shared handler before requests reach Next.
	const serveWebdav = async (request: IncomingMessage, response: ServerResponse) => {
		try {
			const headers = new Headers();
			for (const [key, value] of Object.entries(request.headers)) {
				if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
				else if (value !== undefined) headers.set(key, value);
			}
			const url = `http://${headers.get("host") ?? `${host}:${port}`}${request.url ?? "/"}`;
			request.resume();
			const webdavResponse = await handleWebdav(new Request(url, { method: request.method, headers }), env);
			response.writeHead(webdavResponse.status, Object.fromEntries(webdavResponse.headers.entries()));
			if (webdavResponse.body) Readable.fromWeb(webdavResponse.body as import("node:stream/web").ReadableStream).pipe(response);
			else response.end();
		} catch (error) {
			console.error("WebDAV request failed", error);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	};

	const server = createServer((request, response) => {
		// The only client IP that cannot be forged is the socket's. Next sees
		// re-serialized headers, so stamp the resolved IP into a private header
		// after removing every client-supplied forwarding header — otherwise a
		// direct attacker could rotate them to dodge the login rate limiter.
		const forwarded = request.headers["x-forwarded-for"];
		const hops = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)
			?.split(",")
			.map((hop) => hop.trim())
			.filter(Boolean) ?? [];
		const clientIp = (trustProxy ? hops.at(-1) : undefined) ?? request.socket.remoteAddress;
		delete request.headers["cf-connecting-ip"];
		delete request.headers["x-forwarded-for"];
		delete request.headers["x-mailflare-client-ip"];
		if (clientIp) request.headers["x-mailflare-client-ip"] = clientIp;
		// WebDAV verbs that Next route handlers cannot dispatch are served here;
		// the standard verbs flow through app/webdav/[[...path]]/route.ts instead.
		const { pathname } = parse(request.url ?? "/", true);
		if ((pathname === "/webdav" || pathname?.startsWith("/webdav/") || (pathname === "/" && request.method === "OPTIONS")) && WEBDAV_EDGE_METHODS.has(request.method ?? "")) {
			void serveWebdav(request, response);
			return;
		}
		void handle(request, response, parse(request.url ?? "/", true));
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const { pathname } = parse(request.url ?? "/");
		if (pathname !== "/api/realtime") {
			// Next's own dev-mode HMR socket, or anything else, is not ours.
			if (dev) app.getUpgradeHandler()(request, socket, head);
			else socket.destroy();
			return;
		}
		// Same origin policy as worker.ts: reject browser handshakes from another origin (CSWSH).
		// Non-browser clients send no Sec-Fetch-Site/Origin and are unaffected.
		const fetchSite = request.headers["sec-fetch-site"];
		const wsOrigin = request.headers.origin;
		let originOk = fetchSite !== "cross-site" && fetchSite !== "same-site";
		if (originOk && typeof wsOrigin === "string") {
			try {
				originOk = new URL(wsOrigin).host === request.headers.host;
			} catch {
				originOk = false;
			}
		}
		if (!originOk) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const cookie = request.headers.cookie ?? "";
		const token = getSessionTokenFromRequest(new Request("http://localhost/", { headers: { cookie } }));
		void getUserFromSession(env, token).then((user) => {
			if (!user || user.disabled) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws) => runtime.realtime.attach(user.id, ws));
		});
	});

	server.listen(port, host, () => {
		console.log(`Mailflare listening on http://${host}:${port} (data in ${runtime.dataDir})`);
	});

	const smtpPort = Number(process.env.SMTP_INBOUND_PORT ?? 25);
	if (smtpPort > 0) {
		startSmtpListener(env, runtime.mailer, {
			port: smtpPort,
			host: process.env.SMTP_INBOUND_HOST,
			maxSize: Number(process.env.SMTP_MAX_SIZE ?? 36 * 1024 * 1024),
			hostname: process.env.MAIL_HOSTNAME,
			tls: process.env.SMTP_TLS_KEY && process.env.SMTP_TLS_CERT ? { keyPath: process.env.SMTP_TLS_KEY, certPath: process.env.SMTP_TLS_CERT } : null,
		});
	}
	const stopScheduler = startScheduler(env);

	const shutdown = () => {
		stopScheduler();
		runtime.inboundQueue.stop();
		runtime.outboundQueue.stop();
		runtime.agentQueue.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((error) => {
	console.error("Mailflare failed to start", error);
	process.exit(1);
});
