import { Suspense } from "react";
import { MeetChatView } from "../chat-view";

export default function MeetChatPage() {
	return (
		<Suspense fallback={null}>
			<MeetChatView />
		</Suspense>
	);
}
