'use client';

// Command — filterable, keyboard-driven command list (DASHBOARD_REDESIGN_
// 2026-09 primitive), the reusable core of the ⌘K palette. Dependency-free
// (the app ships no cmdk); tokens-only. Type to filter (label + keywords),
// ↑/↓ to move the active row, Enter to run it, Escape handled by the caller
// (CommandDialog). The existing app-specific command-palette.tsx keeps its own
// bespoke logic; this is the shared primitive future palettes build on.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface CommandOption {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  onSelect: () => void;
}

function filterOptions(options: CommandOption[], query: string): CommandOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(q));
}

export function Command({
  options,
  placeholder = 'Type a command or search…',
  emptyLabel = 'No results.',
  autoFocus = true,
  className = '',
}: {
  options: CommandOption[];
  placeholder?: string;
  emptyLabel?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = 'command-list';

  const results = useMemo(() => filterOptions(options, query), [options, query]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Keep the active row valid as the filtered list shrinks/grows.
  useEffect(() => {
    setActive((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results.length]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.onSelect();
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-[var(--radius)] border border-[rgb(var(--border-strong))] bg-[rgb(var(--bg-raised))] shadow-xl',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full border-b border-[rgb(var(--border-subtle))] bg-transparent px-4 py-3 text-sm text-[rgb(var(--text-primary))] placeholder:text-[rgb(var(--text-muted))] focus:outline-none"
      />
      <ul id={listId} role="listbox" className="max-h-80 overflow-y-auto overscroll-contain p-1.5">
        {results.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-[rgb(var(--text-muted))]">{emptyLabel}</li>
        ) : (
          results.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={o.onSelect}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  i === active
                    ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--text-primary))]'
                    : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))]',
                )}
              >
                <span className="min-w-0 truncate">{o.label}</span>
                {o.hint && (
                  <span className="shrink-0 font-mono text-xs text-[rgb(var(--text-muted))]">{o.hint}</span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** Command mounted in a top-anchored overlay — a ready-to-use ⌘K palette shell. */
export function CommandDialog({
  open,
  onClose,
  ...commandProps
}: { open: boolean; onClose: () => void } & React.ComponentProps<typeof Command>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 px-4 pt-[15vh]"
      onClick={onClose}
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Command {...commandProps} />
      </div>
    </div>
  );
}
