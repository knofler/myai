'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function StatusError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Status" error={error} reset={reset} />;
}
