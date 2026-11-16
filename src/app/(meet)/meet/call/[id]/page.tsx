import { Suspense } from "react";
import { MeetCallView } from "../../call-view";

export default async function MeetCallPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return (
		<Suspense fallback={null}>
			<MeetCallView meetingId={id} />
		</Suspense>
	);
}
