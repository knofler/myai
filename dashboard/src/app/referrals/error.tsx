'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function ReferralsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Referrals" error={error} reset={reset} />;
}
