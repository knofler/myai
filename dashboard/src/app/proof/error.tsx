'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ProofError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Proof" error={error} reset={reset} />;
}
