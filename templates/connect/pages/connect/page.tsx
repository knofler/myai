"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HubCard {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  countLabel: string;
  accentBorder: string;
  accentBg: string;
  accentText: string;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG to keep self-contained)
// ---------------------------------------------------------------------------

function BugIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.867.966 1.867 2.013 0 1.047-.83 1.867-1.867 2.013A15.152 15.152 0 0112 17.25c-1.148 0-2.278-.08-3.383-.237C7.58 16.867 6.75 16.047 6.75 15c0-1.047.83-1.867 1.867-2.013A15.152 15.152 0 0112 12.75zM12 12.75c2.485 0 4.5-4.03 4.5-9S14.485 0 12 0 7.5-.28 7.5 3.75s2.015 9 4.5 9z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 15H4.875c-1.036 0-1.875.84-1.875 1.875v.375c0 1.036.84 1.875 1.875 1.875h1.5M17.25 15h1.875c1.036 0 1.875.84 1.875 1.875v.375c0 1.036-.84 1.875-1.875 1.875h-1.5M9 9.75L6 6M15 9.75L18 6" />
    </svg>
  );
}

function FeatureIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConnectHubPage() {
  const [bugCount, setBugCount] = useState<number | null>(null);
  const [featureCount, setFeatureCount] = useState<number | null>(null);
  const [helpCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchCounts() {
      try {
        const [bugsRes, featuresRes] = await Promise.allSettled([
          fetch("/api/connect/bugs?limit=1", { credentials: "include" }),
          fetch("/api/connect/features?limit=1", { credentials: "include" }),
        ]);

        if (!cancelled) {
          if (bugsRes.status === "fulfilled" && bugsRes.value.ok) {
            const data = await bugsRes.value.json();
            setBugCount(data.total ?? 0);
          }
          if (featuresRes.status === "fulfilled" && featuresRes.value.ok) {
            const data = await featuresRes.value.json();
            setFeatureCount(data.total ?? 0);
          }
        }
      } catch {
        // Silently fail — counts will show as dashes
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCounts();
    return () => { cancelled = true; };
  }, []);

  const cards: HubCard[] = [
    {
      title: "Bug Reports",
      description: "Report issues, track resolutions, and see AI-driven analysis of bugs across the platform.",
      href: "/connect/bug",
      icon: <BugIcon />,
      countLabel: bugCount !== null ? `${bugCount}` : "--",
      accentBorder: "border-red-500/30",
      accentBg: "bg-red-500/10",
      accentText: "text-red-400",
    },
    {
      title: "Feature Requests",
      description: "Suggest new features, vote on community ideas, and track implementation progress.",
      href: "/connect/feature",
      icon: <FeatureIcon />,
      countLabel: featureCount !== null ? `${featureCount}` : "--",
      accentBorder: "border-violet-500/30",
      accentBg: "bg-violet-500/10",
      accentText: "text-violet-400",
    },
    {
      title: "Help & FAQ",
      description: "Search the knowledge base, read FAQs, and find answers to common questions.",
      href: "/connect/help",
      icon: <HelpIcon />,
      countLabel: helpCount !== null ? `${helpCount}` : "--",
      accentBorder: "border-blue-500/30",
      accentBg: "bg-blue-500/10",
      accentText: "text-blue-400",
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 lg:px-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">
          Connect Hub
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Help, bug reports, and feature requests
        </p>
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className={`group overflow-hidden rounded-lg border bg-zinc-900 transition-all hover:bg-zinc-800/80 hover:shadow-lg ${card.accentBorder}`}
          >
            <div className="p-6">
              {/* Icon + Count Row */}
              <div className="flex items-start justify-between">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${card.accentBg} ${card.accentText}`}>
                  {card.icon}
                </div>
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${card.accentBg} ${card.accentText} border ${card.accentBorder}`}>
                  {loading ? (
                    <span className="h-3 w-6 animate-pulse rounded bg-zinc-700" />
                  ) : (
                    card.countLabel
                  )}
                </span>
              </div>

              {/* Title */}
              <h3 className="mt-4 text-base font-semibold text-zinc-100 group-hover:text-white transition-colors">
                {card.title}
              </h3>

              {/* Description */}
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
                {card.description}
              </p>

              {/* Arrow hint */}
              <div className="mt-4 flex items-center text-sm font-medium text-zinc-500 group-hover:text-zinc-300 transition-colors">
                <span>View</span>
                <svg className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
