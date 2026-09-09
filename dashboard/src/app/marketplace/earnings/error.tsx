'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function MarketplaceEarningsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Creator Earnings" error={error} reset={reset} />;
}
