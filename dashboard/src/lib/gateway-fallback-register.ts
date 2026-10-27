// Registers the Atlas fallback for lib/gateway.ts (server only). Imported by
// instrumentation.ts at server boot — never by a client-reachable module, so
// mongoose / next/headers stay out of browser bundles. globalThis (not a module
// variable) because Next bundles instrumentation separately from route handlers.
import { GATEWAY_FALLBACK_KEY } from './gateway';
import { atlasHandles, callAtlasTool } from './gateway-atlas';
import { getActiveTenant } from './tenant';

(globalThis as Record<string, unknown>)[GATEWAY_FALLBACK_KEY] = async (toolName: string, args: Record<string, unknown>) => {
  if (!atlasHandles(toolName)) return null;
  return callAtlasTool(toolName, args, await getActiveTenant());
};
