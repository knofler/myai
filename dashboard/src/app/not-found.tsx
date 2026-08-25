import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="max-w-xl mx-auto mt-24 text-center space-y-5">
      <p className="text-6xl font-bold text-zinc-800">404</p>
      <h1 className="text-xl font-bold text-[rgb(var(--text-primary))]">Page not found</h1>
      <p className="text-sm text-[rgb(var(--text-muted))]">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[rgb(var(--bg-hover))] border border-zinc-700 text-sm text-[rgb(var(--text-primary))] hover:bg-zinc-700 transition-colors"
      >
        Back to Mission Control
      </Link>
    </div>
  );
}
