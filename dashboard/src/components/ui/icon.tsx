// Icon — the dashboard's glyph set. Inline SVG, no dependency.
//
// WHY NOT lucide-react: every other primitive here is "tokens-only,
// dependency-free" (see ui/empty-state.tsx), the dashboard ships in a 1g
// container, and we need ~20 glyphs. A 400-icon package for 20 glyphs is the
// wrong trade, and a runtime icon font would be a second font to load.
//
// WHY IT EXISTS (operator directive D5, 2026-09-16): "Your myAI dashboard,
// homepage for the app looks good, rest still looks Linux console, replicate
// home page pattern everywhere like big icons and meaningful messages."
// PageHeader had no icon slot at all, so every page below the homepage opened
// with a bare text heading over a dense table — the console look.
//
// CONVENTIONS
//   * 24x24 viewBox, stroke-based, `currentColor` — so colour comes from the
//     parent's token class and the icon works in both themes with no extra config.
//   * strokeWidth 1.75 at every size: hairlines disappear on a dark ground at
//     display sizes, and 2 looks clumsy inline.
//   * aria-hidden by default. These are decorative next to a real heading;
//     pass a `label` only when the icon is the ONLY thing conveying meaning.

import { cn } from '@/lib/utils';

export type IconName =
  | 'home' | 'work' | 'brain' | 'fleet' | 'projects' | 'runs' | 'memory'
  | 'search' | 'analytics' | 'revenue' | 'billing' | 'security' | 'audit'
  | 'logs' | 'sessions' | 'apps' | 'marketplace' | 'connectors' | 'keys'
  | 'system' | 'status' | 'swarm' | 'velocity' | 'savings' | 'docs'
  | 'notifications' | 'context' | 'registry' | 'recap' | 'dot'
  // State glyphs for stat tiles (colour = meaning, ui/tone.ts): done / needs
  // you / failed / queued / time.
  | 'check' | 'alert' | 'cross' | 'queue' | 'clock';

// One entry per glyph: the inner paths of a 24x24 stroke icon.
const PATHS: Record<IconName, React.ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
  work: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 12h18" /></>,
  brain: <><path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V16a3 3 0 0 0 4 2.8" /><path d="M12 5a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V16a3 3 0 0 1-4 2.8" /><path d="M12 5v14" /></>,
  fleet: <><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  projects: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  runs: <><path d="M5 3v18l14-9z" /></>,
  memory: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></>,
  analytics: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  revenue: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  billing: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  security: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></>,
  audit: <><path d="M9 3h6l4 4v14H5V3z" /><path d="M9 12h6M9 16h4" /></>,
  logs: <><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></>,
  sessions: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  apps: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><path d="M17 13v8M13 17h8" /></>,
  marketplace: <><path d="M3 9h18l-1.5 11H4.5z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></>,
  connectors: <><path d="M9 7V4M15 7V4" /><rect x="7" y="7" width="10" height="7" rx="2" /><path d="M12 14v6" /></>,
  keys: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v4" /></>,
  system: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /></>,
  status: <><path d="M3 12h4l2-5 3 10 2.5-5H21" /></>,
  swarm: <><circle cx="12" cy="6" r="2.5" /><circle cx="5" cy="17" r="2.5" /><circle cx="19" cy="17" r="2.5" /><path d="M10.5 8 6.5 15M13.5 8l4 7M7.5 17h9" /></>,
  velocity: <><path d="M12 20a8 8 0 1 1 8-8" /><path d="m12 12 5-3" /></>,
  savings: <><path d="M21 12a9 9 0 1 1-9-9" /><path d="M12 7v5l4 2" /><path d="M16 3h5v5" /></>,
  docs: <><path d="M6 3h9l4 4v14H6z" /><path d="M10 11h6M10 15h6" /></>,
  notifications: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" /><path d="M10.5 19a2 2 0 0 0 3 0" /></>,
  context: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18-3-3-3-15 0-18" /></>,
  registry: <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="8" cy="7" r="1.2" /><circle cx="14" cy="12" r="1.2" /><circle cx="10" cy="17" r="1.2" /></>,
  recap: <><path d="M4 6h16v13H4z" /><path d="M4 10h16M9 3v3M15 3v3" /></>,
  dot: <circle cx="12" cy="12" r="4" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.5" /></>,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  queue: <path d="M4 6h16M4 12h16M4 18h10" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
};

const SIZES = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
  xl: 'h-9 w-9',   // the PageHeader / EmptyState "big icon" size
} as const;

export function Icon({
  name,
  size = 'md',
  className = '',
  label,
}: {
  name: IconName;
  size?: keyof typeof SIZES;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(SIZES[size], 'shrink-0', className)}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {PATHS[name] ?? PATHS.dot}
    </svg>
  );
}

// The tinted rounded tile the homepage uses behind a glyph. Pulled out so a
// page header, an empty state and a stat tile all get the SAME treatment
// rather than three near-misses.
export function IconTile({
  name,
  size = 'xl',
  className = '',
}: {
  name: IconName;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-xl bg-[rgb(var(--bg-surface))] p-2.5 text-[rgb(var(--text-secondary))]',
        className,
      )}
    >
      <Icon name={name} size={size} />
    </span>
  );
}
