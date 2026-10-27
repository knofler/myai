"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";

/** A pending bar that appears only after 100 ms, so a fast navigation shows
 *  nothing and a slow one shows the tap was received. Must render inside the
 *  <Link> — `useLinkStatus` reads the status of its nearest parent Link. */
function PendingBar() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      data-pending={pending ? "" : undefined}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-primary opacity-0 transition-[opacity,transform] duration-300 data-[pending]:scale-x-100 data-[pending]:opacity-100 data-[pending]:delay-100 motion-reduce:transition-none"
    />
  );
}

/** Navigation link with instant press feedback (web-perceived-performance
 *  skill, layer 1). Keep it a real <Link> — never a button calling router.push
 *  — so prefetching, middle-click and accessibility all keep working. */
export function NavLink({ className, children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      className={cn(
        "relative inline-flex items-center overflow-hidden rounded-md transition-transform active:scale-[0.97] active:bg-muted motion-reduce:transition-none motion-reduce:active:scale-100",
        className,
      )}
    >
      {children}
      <PendingBar />
    </Link>
  );
}
