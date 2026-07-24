import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe — used by Docker healthcheck and uptime monitors.
 *  Stays dependency-free so it answers even when Mongo/Anthropic are down. */
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: process.env.npm_package_name ?? "app",
    timestamp: new Date().toISOString(),
  });
}
