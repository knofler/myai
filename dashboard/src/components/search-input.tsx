'use client';

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full max-w-md bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-md px-4 py-2 text-sm text-[rgb(var(--text-primary))] placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 transition-colors"
    />
  );
}
