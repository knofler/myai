'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function SwarmError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Swarm" error={error} reset={reset} />;
}
