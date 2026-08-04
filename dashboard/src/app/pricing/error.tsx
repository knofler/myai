'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function PricingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Pricing" error={error} reset={reset} />;
}
