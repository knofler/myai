'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function TermsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Terms of Service" error={error} reset={reset} />;
}
