'use client';

// Replays the first-run app walkthrough (the ProductTour overlay). The header
// "Tour" control now navigates to /tour — the operator's way in to the brain
// tour — so the overlay replay lives here, on the /tour page itself.
import { TOUR_START_EVENT } from '@/components/product-tour';

export function ReplayAppTourButton() {
  return (
    <button
      type="button"
      data-testid="tour-replay"
      onClick={() => window.dispatchEvent(new Event(TOUR_START_EVENT))}
      className="rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] px-3 py-1.5 text-xs text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]"
    >
      Replay the app walkthrough
    </button>
  );
}
