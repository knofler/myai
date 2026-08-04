'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function PrivacyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Privacy Policy" error={error} reset={reset} />;
}
