'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function AcceptableUseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Acceptable Use Policy" error={error} reset={reset} />;
}
