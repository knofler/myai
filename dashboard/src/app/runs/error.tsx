'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function RunsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Run History" error={error} reset={reset} />;
}
