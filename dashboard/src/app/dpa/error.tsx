'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function DpaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Data Processing Addendum" error={error} reset={reset} />;
}
