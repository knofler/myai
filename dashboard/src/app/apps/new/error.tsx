'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function NewAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="New App" error={error} reset={reset} />;
}
