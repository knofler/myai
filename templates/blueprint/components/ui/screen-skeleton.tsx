import { cn } from "@/app/lib/utils";

/** Loading state for any route (web-perceived-performance skill, layer 1).
 *  Use it from every `loading.tsx` that sits over a server fetch: without one,
 *  Next keeps the old screen until the new one renders and a tap feels dead.
 *  Pass the real screen's title so the swap to real content is seamless. */
export function ScreenSkeleton({ title, rows = 4, className }: { title?: string; rows?: number; className?: string }) {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className={cn("mx-auto flex w-full max-w-2xl flex-col gap-4 p-8", className)}
    >
      {title ? (
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      ) : (
        <div className="h-8 w-48 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      ))}
      <span className="sr-only">Loading…</span>
    </main>
  );
}
