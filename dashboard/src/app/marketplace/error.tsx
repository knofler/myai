'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function MarketplaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Marketplace" error={error} reset={reset} />;
}
