import { Suspense } from "react";
import { MeetMeetingsView } from "../meetings-view";

export default function MeetMeetingsPage() {
	return (
		<Suspense fallback={null}>
			<MeetMeetingsView />
		</Suspense>
	);
}
