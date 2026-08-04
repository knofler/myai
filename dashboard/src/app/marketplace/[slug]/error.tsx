'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function MarketplaceItemError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Marketplace Item" error={error} reset={reset} />;
}
