'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ContextError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Your Context" error={error} reset={reset} />;
}
