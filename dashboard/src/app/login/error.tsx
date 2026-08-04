'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Sign In" error={error} reset={reset} />;
}
