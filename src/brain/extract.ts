import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildThreadExtractionPrompt } from "./prompts.js";
import { parseUnits } from "./parse.js";
import type { KnowledgeUnit } from "./types.js";

/** One Anthropic Sonnet call → validated, PII-dropped KnowledgeUnits. Throws on API error. */
export async function extractFromTranscript(transcript: string): Promise<KnowledgeUnit[]> {
  const cfg = loadConfig();
  if (!cfg.llm.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const client = new Anthropic({ apiKey: cfg.llm.apiKey });
  const resp = await client.messages.create({
    model: cfg.llm.model,
    max_tokens: 1500,
    messages: [{ role: "user", content: buildThreadExtractionPrompt(transcript) }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  logger.debug({ units: "extracted" }, "brain extract");
  return parseUnits(text);
}
