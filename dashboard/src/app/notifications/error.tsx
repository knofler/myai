'use client';

import { RouteError } from '@/components/boundary/route-error';

export default function NotificationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Notifications" error={error} reset={reset} />;
}
