'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ShowcaseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Showcase" error={error} reset={reset} />;
}
