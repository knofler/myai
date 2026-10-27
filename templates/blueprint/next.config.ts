import type { NextConfig } from "next";
// @sentry/nextjs v10 deprecated importing withSentryConfig from the package
// root (removed entirely in v11) — import from the dedicated config subpath.
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mongoose is a server-only dependency — keep it out of the client bundle.
  serverExternalPackages: ["mongoose"],
};

// Sentry wraps the config for source-map upload + automatic instrumentation.
// All Sentry env vars are optional — the wrapper is a no-op without a DSN.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
