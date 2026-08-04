'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function DocumentationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Documentation" error={error} reset={reset} />;
}
