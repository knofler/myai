'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function MarketplaceReviewDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Review Submission" error={error} reset={reset} />;
}
