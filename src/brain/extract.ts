import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildThreadExtractionPrompt, buildCanonicalDocExtractionPrompt } from "./prompts.js";
import { parseUnits } from "./parse.js";
import type { KnowledgeUnit } from "./types.js";

/** One Anthropic Sonnet call → validated, PII-dropped KnowledgeUnits. Throws on API error. */
export async function extractFromTranscript(transcript: string): Promise<KnowledgeUnit[]> {
  const cfg = loadConfig();
  if (!cfg.llm.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const client = new Anthropic({ apiKey: cfg.llm.apiKey });
  const resp = await client.messages.create({
    model: cfg.llm.model,
    max_tokens: 3000,
    messages: [{ role: "user", content: buildThreadExtractionPrompt(transcript) }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  logger.debug({ units: "extracted" }, "brain extract");
  return parseUnits(text);
}

/** One Anthropic Sonnet call → validated, PII-dropped KnowledgeUnits from a CANONICAL SOP. */
export async function extractFromCanonicalDoc(transcript: string): Promise<KnowledgeUnit[]> {
  const cfg = loadConfig();
  if (!cfg.llm.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const client = new Anthropic({ apiKey: cfg.llm.apiKey });
  const resp = await client.messages.create({
    model: cfg.llm.model,
    // Long SOPs (12-18K input chars) produce many units; 3000 tokens truncated
    // the JSON for long docs, causing parseUnits to silently return [].
    max_tokens: 8192,
    messages: [{ role: "user", content: buildCanonicalDocExtractionPrompt(transcript) }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const units = parseUnits(text);
  // Visibility into per-doc yield: shows up in the GH Actions log so we can
  // spot under-extraction (e.g., max_tokens still tight or PII filter dropping units).
  logger.info({ unitsFromLlm: units.length, rawLen: text.length }, "brain extract canonical");
  return units;
}
