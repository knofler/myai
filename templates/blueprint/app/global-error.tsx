"use client";

/** Root-level error boundary (App Router convention: app/global-error.tsx).
 *  Replaces the ENTIRE root layout when triggered, so it renders its own
 *  <html>/<body> and must not depend on anything from app/layout.tsx's
 *  render tree (no shared context, no Tailwind classes — globals.css isn't
 *  guaranteed to be loaded here). Inline styles only, deliberately. */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Something went wrong</h1>
        <p style={{ color: "#666" }}>An unexpected error occurred.</p>
        <button
          onClick={() => reset()}
          style={{ marginTop: "1rem", padding: "0.5rem 1rem", cursor: "pointer" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
