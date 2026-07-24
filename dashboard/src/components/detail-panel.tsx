'use client';

import { ReactNode, useEffect, useRef } from 'react';

export function DetailPanel({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="backdrop-enter fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      {/* Full-width sheet on phones (the 90vw sliver left a dead gutter and
          made content feel cramped); classic right drawer from sm up. Safe-area
          padding keeps the header/footer clear of the iOS status bar + home
          indicator in standalone (home-screen) mode. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel-enter fixed top-0 right-0 h-screen w-full sm:w-[600px] sm:max-w-[90vw] bg-zinc-900 border-l border-zinc-800 z-50 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
      >
        <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 px-6 py-4 pt-[calc(1rem+env(safe-area-inset-top))] flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100 truncate">{title}</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close panel"
            className="tap-press shrink-0 flex items-center justify-center w-9 h-9 -mr-2 rounded-lg text-zinc-400 hover:text-zinc-200 active:bg-zinc-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </>
  );
}
