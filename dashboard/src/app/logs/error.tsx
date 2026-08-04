'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function LogsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Logs" error={error} reset={reset} />;
}
