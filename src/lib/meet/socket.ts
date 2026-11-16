"use client";

import type { MeetNotification } from "@/lib/realtime/types";

type MeetEventHandler = (event: MeetNotification) => void;

const HEARTBEAT_MS = 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One shared `/api/realtime` socket for the whole app session. Meet payloads
 * are broadcast here by the server side of the channel; mail events on the
 * same socket are ignored. Presence heartbeats (`meet.ping`) ride it too.
 */
class MeetSocket {
	private socket: WebSocket | null = null;
	private handlers = new Set<MeetEventHandler>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;
	private started = false;

	subscribe(handler: MeetEventHandler): () => void {
		this.handlers.add(handler);
		this.start();
		return () => {
			this.handlers.delete(handler);
		};
	}

	send(message: string) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
	}

	private start() {
		if (this.started || typeof window === "undefined") return;
		this.started = true;
		this.connect();
		this.heartbeatTimer = setInterval(() => this.send("meet.ping"), HEARTBEAT_MS);
		document.addEventListener("visibilitychange", this.handleVisibility);
	}

	private handleVisibility = () => {
		if (document.visibilityState === "visible" && this.socket?.readyState !== WebSocket.OPEN) this.connect();
	};

	private connect() {
		if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/realtime`;
		const socket = new WebSocket(url);
		this.socket = socket;
		socket.onopen = () => {
			this.reconnectDelay = RECONNECT_MIN_MS;
			this.send("meet.ping");
		};
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			try {
				const payload = JSON.parse(event.data) as MeetNotification & { type?: string };
				if (typeof payload.type === "string" && payload.type.startsWith("meet.")) {
					for (const handler of this.handlers) handler(payload);
				}
			} catch {
				// Not JSON — ignore.
			}
		};
		socket.onclose = () => {
			this.socket = null;
			if (this.reconnectTimer) return;
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
				this.connect();
			}, this.reconnectDelay);
		};
		socket.onerror = () => socket.close();
	}
}

export const meetSocket = new MeetSocket();
