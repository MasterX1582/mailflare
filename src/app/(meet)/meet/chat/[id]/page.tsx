import { Suspense } from "react";
import { MeetChatView } from "../../chat-view";

export default async function MeetChatConversationPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return (
		<Suspense fallback={null}>
			<MeetChatView key={id} conversationId={id} />
		</Suspense>
	);
}
