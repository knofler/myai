import Anthropic from "@anthropic-ai/sdk";

/** Shared Anthropic client. Use the latest, most capable model by default.
 *  Model IDs (2026): Opus 4.8 `claude-opus-4-8`, Sonnet 4.6 `claude-sonnet-4-6`,
 *  Haiku 4.5 `claude-haiku-4-5-20251001`. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — add it to .env.local");
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/** One-shot completion helper. */
export async function complete(
  prompt: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const res = await getAnthropic().messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
