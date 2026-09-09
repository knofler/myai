'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function MarketplaceReviewQueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Review Queue" error={error} reset={reset} />;
}
