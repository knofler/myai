'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function SessionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Active Sessions" error={error} reset={reset} />;
}
