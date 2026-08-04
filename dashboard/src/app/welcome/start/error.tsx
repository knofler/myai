'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function WelcomeStartError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Get Started" error={error} reset={reset} />;
}
