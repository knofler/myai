/**
 * ADR-027 §3 (executeTool declared-capability + resource-ceiling gate,
 * `core/rbac.ts`'s `assertDeclaredCapability`) and §4 (context isolation,
 * `context-isolation.ts`) wired together. `context-isolation.ts`'s own module
 * comment calls this out as "the eventual invocation loader must call
 * through" — this is that loader.
 *
 * There is still no live sandbox runtime (container vs. V8 isolate vs.
 * subprocess+seccomp is explicitly out of scope for ADR-027, an
 * implementation-time choice) — `execute` below is the seam a future runtime
 * plugs into. Everything AROUND that seam is real and load-bearing today:
 * input isolation (§4.1), the wall-clock/tool-call/output-size ceilings (§3),
 * gating every chained tool call through the real `executeTool` so
 * `assertDeclaredCapability` actually applies, wrapping output before it is
 * ever returned to a caller (§4.2), and the untrusted-argument marking
 * discipline for chaining a package's own output into another tool call
 * (§4.3).
 */
import type { ToolContext, SandboxContextMarker, SandboxResourceLimits } from '../core/tenant-context.js';
import {
  buildSandboxInvocationInput,
  wrapSandboxOutput,
  markOutputAsUntrustedToolArgument,
  unwrapUntrustedToolArgument,
  assertInvocationToolsWithinExposableSurface,
  type SandboxInvocationContext,
  type SandboxInvocationInput,
  type SandboxOutput,
  type JsonValue,
} from './context-isolation.js';

export type { SandboxResourceLimits };

/** Thrown when a sandboxed invocation's execution exceeds `maxWallClockMs`
 *  (ADR-027 §3) — the invocation aborts; no partial effect surfaces. */
export class SandboxTimeoutError extends Error {
  readonly code = 'SANDBOX_TIMEOUT';
  constructor(maxWallClockMs: number) {
    super(`sandboxed invocation exceeded maxWallClockMs (${maxWallClockMs}ms) (ADR-027 §3)`);
    this.name = 'SandboxTimeoutError';
  }
}

/** Thrown when a sandboxed invocation's raw output exceeds `maxOutputBytes`
 *  (ADR-027 §3) — the invocation aborts; nothing is wrapped or returned. */
export class SandboxOutputCeilingError extends Error {
  readonly code = 'SANDBOX_OUTPUT_CEILING';
  constructor(maxOutputBytes: number, actualBytes: number) {
    super(
      `sandboxed invocation output (${actualBytes}B) exceeded maxOutputBytes (${maxOutputBytes}) (ADR-027 §3)`,
    );
    this.name = 'SandboxOutputCeilingError';
  }
}

export interface RunSandboxedInvocationParams {
  sandboxCtx: SandboxInvocationContext;
  /** The manifest's declared tool set for this invocation (ADR-027 §2). */
  declaredTools: readonly string[];
  resourceLimits: SandboxResourceLimits;
  /** The explicit, scoped input fields for this call — never the ambient
   *  session (§4.1, enforced by `buildSandboxInvocationInput` below). */
  fields: Readonly<Record<string, JsonValue>>;
  invocationId: string;
  /** The caller's real, server-derived context (role, tenantId, ...). The
   *  sandboxed dispatch ctx is DERIVED from this and capped to `member`
   *  (ADR-027 §1 "Identity/role" row) — never escalated, never substituted
   *  wholesale. */
  callerCtx: ToolContext;
  /**
   * Dispatches a single tool call through the REAL `executeTool` chokepoint
   * so `assertDeclaredCapability` (core/rbac.ts) actually gates it — injected
   * (rather than imported directly) to avoid a `marketplace/* ` <-> `mcp/tools.ts`
   * import cycle and to keep this module unit-testable without a live
   * dispatcher. Production callers pass `mcp/tools.js`'s `executeTool`.
   */
  dispatchTool: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /**
   * The package execution itself — the seam a future sandbox runtime plugs
   * into. Receives the isolated invocation input (never the ambient session)
   * and a `callTool` callback scoped to THIS invocation's sandboxed ctx;
   * returns the raw string output.
   */
  execute: (
    input: SandboxInvocationInput,
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<string>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SandboxTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run one sandboxed marketplace-package invocation end to end:
 *   1. re-assert the declared tools stay within the curated exposable
 *      surface (§4.4 defense-in-depth, mirrors the publish-time check),
 *   2. isolate the input via `buildSandboxInvocationInput` (§4.1) — the ONLY
 *      sanctioned way to build what the package receives,
 *   3. run `execute` under the `maxWallClockMs` ceiling, with every chained
 *      tool call routed through `dispatchTool` on a ctx carrying
 *      `ctx.sandbox` so `assertDeclaredCapability` (§3) gates it,
 *   4. enforce `maxOutputBytes` on the raw result,
 *   5. wrap the result via `wrapSandboxOutput` (§4.2) BEFORE returning —
 *      nothing downstream of this function ever sees `raw` unwrapped.
 */
export async function runSandboxedInvocation(
  params: RunSandboxedInvocationParams,
): Promise<SandboxOutput> {
  const { sandboxCtx, declaredTools, resourceLimits, fields, invocationId, callerCtx, dispatchTool, execute } =
    params;

  assertInvocationToolsWithinExposableSurface(declaredTools);

  const input = buildSandboxInvocationInput(sandboxCtx, fields);

  const marker: SandboxContextMarker = {
    listingId: sandboxCtx.listingId,
    version: sandboxCtx.version,
    installId: sandboxCtx.installId,
    declaredTools,
    resourceLimits,
    toolCallState: { count: 0 },
  };

  // ADR-027 §1 "Identity/role": capped at member, minus explicit denies —
  // never the caller's real elevated role, regardless of who installed it.
  const sandboxedCtx: ToolContext = { ...callerCtx, role: 'member', sandbox: marker };

  const callTool = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    dispatchTool(name, args, sandboxedCtx);

  const raw = await withTimeout(execute(input, callTool), resourceLimits.maxWallClockMs);

  const actualBytes = Buffer.byteLength(raw, 'utf8');
  if (actualBytes > resourceLimits.maxOutputBytes) {
    throw new SandboxOutputCeilingError(resourceLimits.maxOutputBytes, actualBytes);
  }

  // §4.2 — wrap BEFORE this function ever returns to its caller.
  return wrapSandboxOutput(sandboxCtx, invocationId, raw);
}

/**
 * Build the args object for a privileged tool call whose value comes from a
 * sandboxed package's own prior output (§4.3) — the required mark/unwrap
 * round-trip, so "package output became a tool argument" stays a visible,
 * grep-able call site instead of an ordinary string flowing through
 * untagged. Marking does NOT make the value safe: the target tool's own
 * input validation is still the backstop (§4.3), same as for any other
 * caller-supplied string.
 */
export function buildToolArgsFromSandboxOutput(
  output: SandboxOutput,
  argName: string,
  otherArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const untrusted = markOutputAsUntrustedToolArgument(output);
  return { ...otherArgs, [argName]: unwrapUntrustedToolArgument(untrusted) };
}
