'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ConnectorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Connectors" error={error} reset={reset} />;
}
