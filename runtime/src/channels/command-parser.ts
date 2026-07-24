/**
 * Channel command parser — Phase 3 Chunk C (Telegram command center).
 *
 * Parses a raw inbound channel message into a structured one-shot command.
 * This is the parser ONLY — dispatch lives in registry.ts. Keeping it pure
 * makes it channel-agnostic (Telegram/Discord/HTTP) and unit-testable without
 * mocking the LLM or the network.
 *
 * One-shot dispatch (NEW — routes to agents_invoke / skills_invoke):
 *   /agent <name>: <message>   → invoke a specialist agent ONCE with <message>
 *   /skill <name>: <message>   → invoke a skill ONCE with <message>
 *   /skill <name> <message>    → same (whitespace separator tolerated for skills)
 *   /skill list                → list available skills
 *   /skill | /skill <name>     → usage hint (no message supplied)
 *
 * Deliberately NOT handled here (kind: 'none' — left to the existing
 * conversational routing in registry.ts):
 *   /agent <name>              → switch the session's conversational agent
 *   /agent list                → list available agents
 *
 * The colon is the discriminator for `/agent`: with a colon it is a one-shot
 * dispatch, without a colon it remains the long-lived agent switch. Skill names
 * are kebab-case and never contain whitespace or a colon, so `[^\s:]+` matches a
 * name precisely up to the separator.
 */

export type ChannelCommand =
  | { kind: 'invoke-agent'; name: string; message: string }
  | { kind: 'invoke-skill'; name: string; message: string }
  | { kind: 'list-skills' }
  | { kind: 'skill-usage'; name?: string }
  | { kind: 'none' };

// /agent <name>: <message>  (colon required — colon-less form stays a switch)
const AGENT_INVOKE = /^\/agent\s+([^\s:]+)\s*:\s*([\s\S]+?)\s*$/i;
// /skill list
const SKILL_LIST = /^\/skill\s+list\s*$/i;
// /skill <name>: <message>
const SKILL_INVOKE_COLON = /^\/skill\s+([^\s:]+)\s*:\s*([\s\S]+?)\s*$/i;
// /skill <name> <message>  (whitespace separator — no switch semantics to collide with)
const SKILL_INVOKE_SPACE = /^\/skill\s+([^\s:]+)\s+([\s\S]+?)\s*$/i;
// /skill   or   /skill <name>   (no message)
const SKILL_USAGE = /^\/skill(?:\s+([^\s:]+))?\s*$/i;

/**
 * Parse a raw channel message into a structured command.
 * Returns `{ kind: 'none' }` for anything that is not a one-shot dispatch.
 */
export function parseChannelCommand(raw: string): ChannelCommand {
  const text = raw.trim();

  const agentInvoke = text.match(AGENT_INVOKE);
  if (agentInvoke) {
    return { kind: 'invoke-agent', name: agentInvoke[1], message: agentInvoke[2].trim() };
  }

  // `/skill list` must be checked before the one-shot forms so "list" is not
  // mistaken for a skill name + message.
  if (SKILL_LIST.test(text)) {
    return { kind: 'list-skills' };
  }

  const skillColon = text.match(SKILL_INVOKE_COLON);
  if (skillColon) {
    return { kind: 'invoke-skill', name: skillColon[1], message: skillColon[2].trim() };
  }

  const skillSpace = text.match(SKILL_INVOKE_SPACE);
  if (skillSpace) {
    return { kind: 'invoke-skill', name: skillSpace[1], message: skillSpace[2].trim() };
  }

  const skillUsage = text.match(SKILL_USAGE);
  if (skillUsage) {
    return { kind: 'skill-usage', name: skillUsage[1] };
  }

  return { kind: 'none' };
}
