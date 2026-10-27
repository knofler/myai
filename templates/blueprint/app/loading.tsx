import { ScreenSkeleton } from "@/components/ui/screen-skeleton";

// Route-level loading state (web-perceived-performance skill, layer 1). Add a
// loading.tsx beside every page that fetches on the server; nested ones can
// pass their screen's title to ScreenSkeleton.
export default function Loading() {
  return <ScreenSkeleton />;
}
