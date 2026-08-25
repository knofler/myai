'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function SubprocessorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Subprocessors" error={error} reset={reset} />;
}
