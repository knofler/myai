'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ApiKeysError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="API Keys" error={error} reset={reset} />;
}
