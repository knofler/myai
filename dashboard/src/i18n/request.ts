import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale } from './config';

// No URL-based locale routing (the dashboard's 40+ routes stay exactly as
// they are) — the active locale is resolved per-request from a cookie the
// locale switcher writes (components/locale-switcher.tsx), same pattern as
// the tenant cookie in lib/tenant.ts. Unset/unknown -> DEFAULT_LOCALE.
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
