'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Audit & Permissions" error={error} reset={reset} />;
}
