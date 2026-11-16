import type { WebSocket } from "ws";
import { getUserMailRevision } from "@/lib/realtime/revision";
import type { RevisionPing, RevisionNotification } from "@/lib/realtime/types";
import { markPresence } from "@/lib/meet/realtime";
import { touchLastSeen } from "@/lib/meet/data";

/**
 * Per-user WebSocket fan-out, standing in for the RealtimeHub Durable
 * Object. The HTTP server hands accepted sockets to `attach`; the
 * `REALTIME.getByName(userId).fetch("/notify")` calls the app already makes
 * land in `notify`.
 */
export class RealtimeHubRegistry {
	private readonly sockets = new Map<string, Set<WebSocket>>();
	private env: CloudflareEnv | null = null;

	bindEnv(env: CloudflareEnv) {
		this.env = env;
	}

	attach(userId: string, socket: WebSocket) {
		const set = this.sockets.get(userId) ?? new Set();
		const firstSocket = set.size === 0;
		set.add(socket);
		this.sockets.set(userId, set);
		if (firstSocket && this.env) {
			const env = this.env;
			void markPresence(env, userId, true).catch(() => undefined);
		}
		socket.on("message", (data) => {
			const message = data.toString();
			if (message === "ping") {
				socket.send("pong");
				return;
			}
			if (message === "meet.ping") {
				if (this.env) void touchLastSeen(this.env, userId).catch(() => undefined);
				return;
			}
			void (async () => {
				let ping: RevisionPing;
				try { ping = JSON.parse(message) as RevisionPing; } catch { return; }
				if (ping.type !== "ping" || !this.env) return;
				const revision = await getUserMailRevision(this.env, userId);
				const notification: RevisionNotification = { type: "revision", revision, changed: ping.revision !== null && ping.revision !== revision };
				socket.send(JSON.stringify(notification));
			})().catch(() => socket.close(1011, "Revision lookup failed"));
		});
		socket.on("close", () => {
			set.delete(socket);
			if (set.size === 0) {
				this.sockets.delete(userId);
				if (this.env) {
					const env = this.env;
					void markPresence(env, userId, false).catch(() => undefined);
				}
			}
		});
	}

	notify(userId: string, payload: unknown) {
		const message = JSON.stringify(payload);
		for (const socket of this.sockets.get(userId) ?? []) {
			try {
				socket.send(message);
			} catch {
				socket.close(1011, "Delivery failed");
			}
		}
	}

	connections() {
		let total = 0;
		for (const set of this.sockets.values()) total += set.size;
		return total;
	}

	/** The `DurableObjectNamespace` surface the app uses: `getByName(id).fetch(...)`. */
	namespace(): DurableObjectNamespace {
		const notify = (userId: string, payload: unknown) => this.notify(userId, payload);
		const stub = (userId: string) => ({
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = input instanceof Request ? input : new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname === "/notify" && request.method === "POST") {
					notify(userId, await request.json());
					return new Response(null, { status: 204 });
				}
				return new Response("Not found", { status: 404 });
			},
		});
		return {
			getByName: (name: string) => stub(name),
			idFromName: (name: string) => ({ toString: () => name, name }),
			get: (id: { toString(): string }) => stub(id.toString()),
		} as unknown as DurableObjectNamespace;
	}
}
