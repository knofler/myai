// /documentation now redirects to /showcase.
//
// The docs hub used to aggregate every managed repo's README. That belonged
// to the (planned) per-app surface, not here. /showcase is now THE single
// capability page for THIS tool (myAI / ai_management) — so /documentation
// permanently redirects to it.

import { redirect } from 'next/navigation';

export default function DocumentationPage() {
  redirect('/showcase');
}
