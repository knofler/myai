'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function DevelopersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Developers" error={error} reset={reset} />;
}
