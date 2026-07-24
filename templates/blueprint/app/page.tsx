import { branding } from "@/app/lib/branding";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-bold tracking-tight">{branding.name}</h1>
      <p className="text-lg text-muted-foreground">{branding.description}</p>
      <div className="rounded-lg border border-border bg-card p-6 text-left text-sm">
        <p className="font-semibold">Scaffolded from the Powerhouse Blueprint.</p>
        <ul className="mt-3 list-inside list-disc space-y-1 text-muted-foreground">
          <li>Next.js 15 (App Router) + TypeScript strict</li>
          <li>Tailwind v4 + shadcn/ui</li>
          <li>MongoDB (Mongoose) + Anthropic SDK + Sentry</li>
          <li>Vitest + Playwright + 4 GitHub Actions workflows</li>
        </ul>
        <p className="mt-4 text-muted-foreground">
          Health check:{" "}
          <a href="/api/health" className="underline">
            /api/health
          </a>
          {" · "}
          Demo API:{" "}
          <a href="/api/todos" className="underline">
            /api/todos
          </a>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Run <code className="rounded bg-muted px-1">agent mode</code> in this repo
        to describe what you want to build.
      </p>
    </main>
  );
}
