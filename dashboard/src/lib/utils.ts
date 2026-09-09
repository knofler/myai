// Class-name joiner for the v2 primitives (DASHBOARD_REDESIGN_2026-09).
// Dependency-free by design: this project ships no clsx / tailwind-merge, and
// its hand-rolled shadcn-style primitives never need conflict resolution —
// they compose fixed base classes with a caller `className`. Falsy values are
// dropped so `cn('a', cond && 'b', undefined)` reads cleanly at call sites.
export type ClassValue = string | number | false | null | undefined;

export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
