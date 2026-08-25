'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function TwoFactorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Two-Factor Authentication" error={error} reset={reset} />;
}
