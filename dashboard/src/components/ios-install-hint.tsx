'use client';

// Add-to-Home-Screen hint for iOS Safari visitors on /welcome.
//
// iOS Safari has no beforeinstallprompt event and no install button — the only
// way to install a PWA is the manual Share → "Add to Home Screen" gesture. So
// on iOS Safari (and not already running standalone) we surface a small,
// dismissible bottom banner spelling out that gesture. Everywhere else this
// renders nothing: Android/desktop Chrome get the native install prompt, and an
// already-installed app is skipped.

import { useCallback, useEffect, useState } from 'react';

const DISMISS_KEY = 'myai:welcome:ios-install-dismissed';

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPhone/iPod/iPad — plus iPadOS 13+ which reports as Mac but is touch-capable.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  // Exclude in-app browsers / non-Safari engines that can't "Add to Home Screen".
  const webkit = /WebKit/.test(ua);
  const otherBrowser = /(CriOS|FxiOS|EdgiOS|OPiOS|mercury)/.test(ua);
  return webkit && !otherBrowser;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS exposes navigator.standalone; the media query covers the spec path.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const mqStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  return iosStandalone || mqStandalone;
}

export function IosInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(DISMISS_KEY)) return;
    if (isStandalone()) return;
    if (!isIosSafari()) return;
    setShow(true);
  }, []);

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Install myAI on your home screen"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-zinc-700 bg-zinc-900/95 backdrop-blur px-4 py-3 shadow-xl"
    >
      <div className="flex items-start gap-3">
        <span className="text-xl leading-6 shrink-0" aria-hidden="true">📲</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">Install myAI on your iPhone</p>
          <p className="mt-0.5 text-xs text-zinc-400 leading-snug">
            Tap the Share button{' '}
            <span aria-hidden="true" className="inline-block px-1 text-teal-300">
              􀈂
            </span>
            in Safari, then choose <span className="text-zinc-200">“Add to Home Screen”</span> for a full-screen,
            app-like experience.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install hint"
          className="shrink-0 rounded-lg border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
