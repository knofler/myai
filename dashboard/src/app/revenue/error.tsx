'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function RevenueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Revenue" error={error} reset={reset} />;
}
