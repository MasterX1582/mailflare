"use client";

import { useEffect, useRef } from "react";
import { meetSocket } from "@/lib/meet/socket";
import type { MeetNotification } from "@/lib/realtime/types";

/** Subscribe to Meet realtime events; the handler always sees the latest render's closure. */
export function useMeetEvents(handler: (event: MeetNotification) => void) {
	const ref = useRef(handler);
	useEffect(() => {
		ref.current = handler;
	});
	useEffect(() => meetSocket.subscribe((event) => ref.current(event)), []);
}
