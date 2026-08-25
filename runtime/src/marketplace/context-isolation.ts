/**
 * ADR-027 §4 — context isolation at the sandboxed-package invocation
 * boundary. Distinct from §3 (the `assertDeclaredCapability` role/resource
 * gate at `executeTool` — `core/rbac.ts`, wired at the chokepoint in
 * `mcp/tools.ts`) — this is the structural prompt-injection mitigation: a
 * marketplace package's own
 * text (its skill body, its tool-call output) is attacker-authored content
 * that must never be treated as ambient conversation the invoking session's
 * LLM follows. Every rule below is enforced by what shape of data a call
 * site can even construct or pass on — not by scanning content for "looks
 * like an instruction" (§4's own "structural, not detection-based" stance,
 * since injection detection is not reliable enough to be the primary
 * control).
 *
 * §4.4 (the invocation's declared-tool allowlist can only reference the
 * curated marketplace-exposed subset) is already implemented and enforced at
 * review/publish time — `marketplaceExposableTools()` (core/rbac.ts,
 * ADR-028 §5) plus `validateDeclaredToolsAllowlist` (marketplace/publish.ts).
 * `assertInvocationToolsWithinExposableSurface` below is a defense-in-depth
 * re-assertion of the SAME derivation at the invocation boundary itself —
 * not a second policy, not duplicated logic.
 *
 * There is no live sandbox runtime or install-and-run flow yet (ADR-027 is
 * still spec-only) — same "prove the pure gate logic before it touches
 * infrastructure" posture the ADR's own acceptance criteria (#5) call for.
 * These functions are the contract the invocation loader calls through —
 * `marketplace/sandbox-invoke.ts`'s `runSandboxedInvocation` /
 * `buildToolArgsFromSandboxOutput` thread every one of them (plus §3's
 * `assertDeclaredCapability`) together into the actual call path, once a
 * live runtime exists to drive it.
 */
import { marketplaceExposableTools } from '../core/rbac.js';

/** JSON-serializable value — the only shape a sandboxed invocation's
 *  explicit input fields may take (no live object references, no functions,
 *  nothing that could carry a `ToolContext`/session object by accident). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Identifies the specific listing/version/install a sandboxed call belongs
 *  to — always server-derived from the install record, never caller-supplied
 *  (same posture as `ctx.role`/`ctx.sandbox`, ADR-013/ADR-027 §3). */
export interface SandboxInvocationContext {
  listingId: string;
  version: string;
  installId: string;
}

// ── §4.1 — no ambient session transcript ─────────────────────────────────

/**
 * Key names that would smuggle ambient session/conversation state into a
 * sandboxed invocation's input payload. Closed, hand-maintained — same
 * additive-only posture as the manifest's `declaredTools` allowlist (§2):
 * widening what a sandboxed invocation may receive is a deliberate review,
 * never an incidental field add (e.g. an accidental `...session` spread).
 */
export const AMBIENT_SESSION_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    'transcript',
    'messages',
    'history',
    'conversation',
    'conversationhistory',
    'sessioncontext',
    'priorturns',
    'chathistory',
    'session',
    'agentsession',
  ]),
);

/** Thrown by `buildSandboxInvocationInput` when the caller-constructed
 *  fields carry an ambient-session-shaped key (§4.1 violation). */
export class SandboxInputViolationError extends Error {
  readonly code = 'SANDBOX_AMBIENT_INPUT';
  readonly offendingKeys: readonly string[];

  constructor(offendingKeys: readonly string[]) {
    super(
      `sandboxed invocation input carries ambient-session-shaped key(s) (ADR-027 §4.1): ${offendingKeys.join(', ')}`,
    );
    this.name = 'SandboxInputViolationError';
    this.offendingKeys = offendingKeys;
  }
}

function findAmbientKeys(fields: Readonly<Record<string, JsonValue>>): string[] {
  return Object.keys(fields).filter((k) => AMBIENT_SESSION_KEYS.has(k.toLowerCase()));
}

/** The explicit, scoped payload a sandboxed invocation actually receives —
 *  never "the rest of this conversation" (§4.1). Frozen so a call site
 *  cannot mutate it into an ambient-shaped object after construction. */
export interface SandboxInvocationInput {
  readonly listingId: string;
  readonly version: string;
  readonly installId: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

/**
 * The ONLY sanctioned way to build the payload handed to a sandboxed
 * invocation. `fields` must be the explicit input the invoking flow chose
 * for this specific call — never a spread of `ToolContext`, a live session
 * object, or "everything so far." Fails closed (throws
 * `SandboxInputViolationError`) if `fields` carries a key shaped like
 * ambient session/transcript data.
 */
export function buildSandboxInvocationInput(
  ctx: SandboxInvocationContext,
  fields: Readonly<Record<string, JsonValue>>,
): SandboxInvocationInput {
  const offending = findAmbientKeys(fields);
  if (offending.length > 0) {
    throw new SandboxInputViolationError(offending);
  }
  return Object.freeze({
    listingId: ctx.listingId,
    version: ctx.version,
    installId: ctx.installId,
    input: Object.freeze({ ...fields }),
  });
}

// ── §4.2 — package output is opaque data, not instructions ──────────────

/**
 * A sandboxed package's return value, tagged with its provenance. Opaque by
 * construction — nothing in this module exposes a way to fold `raw` back
 * into the outer session's LLM context as unattributed free text (§4.2).
 * `raw` stays a plain string (packages return text/JSON, not live objects),
 * but the wrapper's *presence* is what forces a call site to go through
 * `renderAttributedOutput` (or `markOutputAsUntrustedToolArgument`, §4.3)
 * instead of splicing `raw` in directly.
 */
export interface SandboxOutput {
  readonly listingId: string;
  readonly version: string;
  readonly installId: string;
  readonly invocationId: string;
  readonly raw: string;
}

/** Wrap a sandboxed invocation's raw return value with its provenance. The
 *  invoking flow calls this immediately on receiving output — before it
 *  touches any other code path. */
export function wrapSandboxOutput(
  ctx: SandboxInvocationContext,
  invocationId: string,
  raw: string,
): SandboxOutput {
  return Object.freeze({
    listingId: ctx.listingId,
    version: ctx.version,
    installId: ctx.installId,
    invocationId,
    raw,
  });
}

/**
 * The only sanctioned way to surface a sandboxed package's output to a user
 * (§4.2: "surfaced as clearly-attributed, quoted content, not blended into
 * the assistant's own voice"). Every line is quote-prefixed and the block is
 * headed with the package's identity — never returns `raw` unattributed.
 */
export function renderAttributedOutput(output: SandboxOutput): string {
  const attribution = `[marketplace package ${output.listingId}@${output.version}]`;
  const quoted = output.raw
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${attribution}\n${quoted}`;
}

// ── §4.3 — no tool-chaining raw output into a privileged tool's args ────

/**
 * A sandboxed package's output, explicitly marked untrusted for use as a
 * subsequent tool call's argument (§4.3). Marking it does NOT make it safe —
 * "the target tool's own input validation is the backstop, sandboxing does
 * not imply the output is safe to use blindly" (§4.3). This wrapper exists
 * so "a package's own output became a privileged tool's argument" is a
 * visible, grep-able call site (`markOutputAsUntrustedToolArgument`) instead
 * of an ordinary string flowing through untagged.
 */
export interface UntrustedToolArgument {
  readonly sourceInvocationId: string;
  readonly sourceListingId: string;
  readonly value: string;
}

/** Mark a sandboxed package's output as untrusted input to whatever tool
 *  call consumes it next — the required step before chaining §4.3. */
export function markOutputAsUntrustedToolArgument(output: SandboxOutput): UntrustedToolArgument {
  return Object.freeze({
    sourceInvocationId: output.invocationId,
    sourceListingId: output.listingId,
    value: output.raw,
  });
}

/**
 * Unwrap an `UntrustedToolArgument` immediately before handing it to the
 * target tool's own validated argument builder. Deliberately does no
 * sanitization itself — that would imply this module can vouch for the
 * value, which §4.3 explicitly says it cannot. Callers must run the target
 * tool's normal input validation on the unwrapped value, same as any other
 * caller-supplied string.
 */
export function unwrapUntrustedToolArgument(arg: UntrustedToolArgument): string {
  return arg.value;
}

// ── §4.4 — declared-tool allowlist bounded by the curated exposed subset ─

/** Thrown when a sandboxed invocation's tool set reaches outside the
 *  curated marketplace-exposed surface (§4.4 violation). */
export class SandboxToolSurfaceViolationError extends Error {
  readonly code = 'SANDBOX_TOOL_OUTSIDE_EXPOSABLE_SURFACE';
  readonly offendingTools: readonly string[];

  constructor(offendingTools: readonly string[]) {
    super(
      `sandboxed invocation tool set includes tool(s) outside the marketplace-exposable surface (ADR-027 §4.4): ${offendingTools.join(', ')}`,
    );
    this.name = 'SandboxToolSurfaceViolationError';
    this.offendingTools = offendingTools;
  }
}

/**
 * Defense-in-depth re-assertion, at the invocation boundary itself, that a
 * sandboxed invocation can only ever reach the curated marketplace-exposed
 * tool subset (§4.4) — never the full ambient ~80-tool surface a first-party
 * agent session sees. This is the SAME derivation `publish.ts`'s
 * `validateDeclaredToolsAllowlist` already enforces at review time; calling
 * it again here guards against a stale or bypassed manifest reaching an
 * invocation without having gone through that gate, not a second policy.
 */
export function assertInvocationToolsWithinExposableSurface(declaredTools: readonly string[]): void {
  const exposable = new Set(marketplaceExposableTools());
  const offending = declaredTools.filter((t) => !exposable.has(t));
  if (offending.length > 0) {
    throw new SandboxToolSurfaceViolationError(offending);
  }
}
