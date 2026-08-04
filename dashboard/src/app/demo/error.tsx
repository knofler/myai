'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function DemoError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Demo" error={error} reset={reset} />;
}
