'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function RevenueNrrError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Net Revenue Retention" error={error} reset={reset} />;
}
