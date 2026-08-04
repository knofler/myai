'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function SecurityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Security" error={error} reset={reset} />;
}
