'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function RecapError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Recap" error={error} reset={reset} />;
}
