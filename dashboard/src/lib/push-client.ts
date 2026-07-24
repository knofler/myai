// Browser-side web-push helpers (REALTIME_NOTIFICATIONS Phase 6).
//
// Wraps the Push API dance: permission → PushManager.subscribe with the
// gateway's VAPID key (fetched via /api/notifications/push) → register the
// subscription with the gateway. Push requires a secure context (HTTPS or
// localhost) and the service worker registered by sw-register.tsx.

export type PushSupport = 'ok' | 'insecure-context' | 'unsupported';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return window.isSecureContext ? 'unsupported' : 'insecure-context';
  }
  if (!window.isSecureContext) return 'insecure-context';
  return 'ok';
}

/** The Push API wants the VAPID key as a Uint8Array, not base64url. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The current subscription on this browser, if any. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Enable push on this device: ask permission, subscribe with the gateway's
 * VAPID key, and register the subscription. Throws with a user-displayable
 * message on any failure.
 */
export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (support === 'insecure-context') throw new Error('Push needs HTTPS (or localhost).');
  if (support === 'unsupported') throw new Error('This browser does not support web push.');

  const keyRes = await fetch('/api/notifications/push');
  if (keyRes.status === 404) throw new Error('Push is not configured on the gateway (set VAPID keys in AI/.env).');
  if (!keyRes.ok) throw new Error('Could not fetch the push key from the gateway.');
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) throw new Error('Gateway returned no VAPID key.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was denied.');

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
    }));

  const saveRes = await fetch('/api/notifications/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!saveRes.ok) {
    throw new Error('Could not register the subscription with the gateway.');
  }
}

/** Disable push on this device: unsubscribe locally and deregister. */
export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await fetch('/api/notifications/push', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}
