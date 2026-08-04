'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function BrainError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Brain" error={error} reset={reset} />;
}
