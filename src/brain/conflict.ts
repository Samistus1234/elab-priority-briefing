import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

export interface ConflictVerdict {
  same_question: boolean;
  conflict: boolean;
  reason: string;
}

const NO_CONFLICT: ConflictVerdict = { same_question: false, conflict: false, reason: "" };

// Per-run budget on LLM judge calls (defense on top of the [0.80,0.92) band gate).
// Orchestrators call setConflictBudget() once at run start.
let budget = Infinity;
export function setConflictBudget(n: number): void { budget = n; }

interface QA { question: string; answer: string; }

export function buildConflictPrompt(candidate: QA, standard: QA): string {
  return [
    "You compare two answers to decide if they CONFLICT as institutional guidance.",
    "Return ONLY a JSON object: {\"same_question\": boolean, \"conflict\": boolean, \"reason\": string}.",
    "- same_question: do both address essentially the same question/topic?",
    "- conflict: true ONLY if, for the same question, the answers give incompatible guidance",
    "  (a client would be told different things). Mere extra detail or rephrasing is NOT a conflict.",
    "- reason: one short sentence naming the contradiction (empty if no conflict).",
    "",
    "EXISTING STANDARD:",
    `Q: ${standard.question}`,
    `A: ${standard.answer}`,
    "",
    "NEW ANSWER:",
    `Q: ${candidate.question}`,
    `A: ${candidate.answer}`,
  ].join("\n");
}

export function parseConflictVerdict(text: string): ConflictVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return NO_CONFLICT;
    const o = JSON.parse(match[0]);
    return {
      same_question: o.same_question === true,
      conflict: o.conflict === true,
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  } catch {
    return NO_CONFLICT;
  }
}

/** Best-effort: returns NO_CONFLICT on budget-exhaustion, missing key, or any API/parse error. */
export async function judgeConflict(candidate: QA, standard: QA): Promise<ConflictVerdict> {
  if (budget <= 0) return NO_CONFLICT;
  budget -= 1;
  const cfg = loadConfig();
  if (!cfg.llm.apiKey) return NO_CONFLICT;
  try {
    const client = new Anthropic({ apiKey: cfg.llm.apiKey });
    const resp = await client.messages.create({
      model: cfg.llm.model,
      max_tokens: 200,
      messages: [{ role: "user", content: buildConflictPrompt(candidate, standard) }],
    });
    const out = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return parseConflictVerdict(out);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "brain: conflict judge failed");
    return NO_CONFLICT;
  }
}
