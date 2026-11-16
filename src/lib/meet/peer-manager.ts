"use client";

/**
 * Mesh WebRTC for Meet calls — one RTCPeerConnection per remote participant,
 * signaling relayed over the meeting's realtime channel. Negotiation follows
 * the "perfect negotiation" pattern (the same offer/answer flow
 * VideoChatPro ran through simple-peer), with the lexicographically smaller
 * user id playing the polite role so offers never deadlock.
 */

interface PeerEntry {
	pc: RTCPeerConnection;
	polite: boolean;
	makingOffer: boolean;
	ignoreOffer: boolean;
	stream: MediaStream | null;
}

export interface MeetPeerManagerOptions {
	meetingId: string;
	selfId: string;
	iceServers: RTCIceServer[];
	sendSignal: (to: string, payload: unknown) => Promise<unknown>;
	onTrack: (userId: string, stream: MediaStream) => void;
	onPeerClosed: (userId: string) => void;
	onConnectionState?: (userId: string, state: RTCPeerConnectionState) => void;
}

interface SignalPayload {
	description?: RTCSessionDescriptionInit;
	candidate?: RTCIceCandidateInit;
}

export class MeetPeerManager {
	private peers = new Map<string, PeerEntry>();
	private localStream: MediaStream | null = null;
	private closed = false;

	constructor(private readonly options: MeetPeerManagerOptions) {}

	setLocalStream(stream: MediaStream | null) {
		this.localStream = stream;
		for (const entry of this.peers.values()) this.attachTracks(entry);
	}

	/** Wire a peer connection for `userId` if one does not exist yet. */
	ensurePeer(userId: string): RTCPeerConnection {
		const existing = this.peers.get(userId);
		if (existing) return existing.pc;
		if (this.closed) throw new Error("Peer manager is closed");

		const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
		const entry: PeerEntry = { pc, polite: this.options.selfId < userId, makingOffer: false, ignoreOffer: false, stream: null };
		this.peers.set(userId, entry);

		pc.onnegotiationneeded = async () => {
			try {
				entry.makingOffer = true;
				await pc.setLocalDescription();
				await this.options.sendSignal(userId, { description: pc.localDescription?.toJSON() } satisfies SignalPayload);
			} catch {
				// Negotiation errors surface through connection state.
			} finally {
				entry.makingOffer = false;
			}
		};
		pc.onicecandidate = (event) => {
			void this.options.sendSignal(userId, { candidate: event.candidate?.toJSON() } satisfies SignalPayload).catch(() => undefined);
		};
		pc.ontrack = (event) => {
			const [stream] = event.streams;
			if (stream) {
				entry.stream = stream;
				this.options.onTrack(userId, stream);
			}
		};
		pc.onconnectionstatechange = () => {
			this.options.onConnectionState?.(userId, pc.connectionState);
			if (pc.connectionState === "failed") pc.restartIce();
		};
		this.attachTracks(entry);
		return pc;
	}

	private attachTracks(entry: PeerEntry) {
		if (!this.localStream) return;
		const senders = entry.pc.getSenders();
		for (const track of this.localStream.getTracks()) {
			if (!senders.some((sender) => sender.track === track)) entry.pc.addTrack(track, this.localStream);
		}
	}

	async handleSignal(from: string, payload: unknown) {
		if (this.closed) return;
		const data = (payload ?? {}) as SignalPayload;
		const pc = this.ensurePeer(from);
		const entry = this.peers.get(from)!;
		try {
			if (data.description) {
				const description = data.description;
				const offerCollision = description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
				entry.ignoreOffer = !entry.polite && offerCollision;
				if (entry.ignoreOffer) return;
				await pc.setRemoteDescription(description);
				if (description.type === "offer") {
					await pc.setLocalDescription();
					await this.options.sendSignal(from, { description: pc.localDescription?.toJSON() } satisfies SignalPayload);
				}
			} else if (data.candidate !== undefined) {
				try {
					if (data.candidate) await pc.addIceCandidate(data.candidate);
				} catch (error) {
					if (!entry.ignoreOffer) throw error;
				}
			}
		} catch {
			// Malformed or stale signal; the next one renegotiates.
		}
	}

	/** Replace the outgoing video track on every peer (screen share on/off). */
	async replaceVideoTrack(track: MediaStreamTrack | null) {
		for (const { pc } of this.peers.values()) {
			const sender = pc.getSenders().find((s) => s.track?.kind === "video");
			if (sender) await sender.replaceTrack(track).catch(() => undefined);
		}
	}

	removePeer(userId: string) {
		const entry = this.peers.get(userId);
		if (!entry) return;
		entry.pc.close();
		this.peers.delete(userId);
		this.options.onPeerClosed(userId);
	}

	participantIds(): string[] {
		return [...this.peers.keys()];
	}

	destroy() {
		this.closed = true;
		for (const userId of [...this.peers.keys()]) this.removePeer(userId);
	}
}
