'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function WelcomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Welcome" error={error} reset={reset} />;
}
