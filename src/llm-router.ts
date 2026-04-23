import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runTool, tools } from "./llm-tools.js";
import type { Scope } from "./permissions.js";

/**
 * Free-text → Claude → tool loop → natural-language response.
 *
 * Flow:
 *   1. Build system prompt that includes scope context (role, name).
 *   2. Send user message to Claude with tool definitions.
 *   3. When Claude emits tool_use blocks, run them and feed results back.
 *   4. When Claude emits a final text response, return it for Telegram.
 *
 * Safety:
 *   - Rate limited per user (in-memory).
 *   - Max 5 tool-use iterations to avoid runaway loops.
 *   - Final text truncated to ~3500 chars for Telegram.
 */

const MAX_TOOL_ITERATIONS = 5;
const MAX_TELEGRAM_CHARS = 3500;

// Rate limit: user_id → array of timestamps within the last hour
const rateBuckets = new Map<string, number[]>();

function checkAndTickRate(userId: string, limit: number): boolean {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const bucket = (rateBuckets.get(userId) ?? []).filter((t) => t > hourAgo);
  if (bucket.length >= limit) {
    rateBuckets.set(userId, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  return true;
}

export async function askLLM(scope: Scope, userMessage: string): Promise<string> {
  const cfg = loadConfig();

  if (!cfg.llm.apiKey) {
    return (
      `Natural-language questions aren't configured yet (no Anthropic API key). ` +
      `For now, use /help to see available commands.`
    );
  }

  if (!checkAndTickRate(scope.user_id, cfg.llm.maxQueriesPerHour)) {
    return `You've hit the hourly question limit (${cfg.llm.maxQueriesPerHour} per user). Try again in a bit.`;
  }

  const client = new Anthropic({ apiKey: cfg.llm.apiKey });

  const systemPrompt = [
    `You are an ELAB ops assistant embedded in a Telegram bot for staff at ELAB Solutions.`,
    `You help staff understand their priority cases, find specific cases, and summarise team workload.`,
    ``,
    `The current user is *${scope.full_name}* (${scope.email}).`,
    `Their role: *${scope.role}*.`,
    scope.role === "ceo"
      ? `They see and can query all cases in the organisation.`
      : scope.role === "lead"
        ? `They can see cases assigned to themselves and their ${scope.visible_user_ids.length - 1} direct reports.`
        : `They can see only cases assigned to themselves.`,
    ``,
    `Rules:`,
    `- Answer from tool results only. If a tool returns nothing, say so — don't invent.`,
    `- Keep responses concise, markdown-formatted for Telegram (use *bold*, \`code\` for refs, bullet lists).`,
    `- If the user asks for something outside their scope, explain the scope limit.`,
    `- Always show case references in backticks (e.g. \`DFL-2181-0426-ELAB\`).`,
    `- If you can't answer with the available tools, suggest /help.`,
  ].join("\n");

  // Convert local tool defs to Anthropic SDK tool format
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as any,
  }));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model: cfg.llm.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "anthropic call failed");
      return `Sorry, I had trouble reaching my reasoning engine. Try again.`;
    }

    // Collect text + tool uses from this turn
    const toolUses: Anthropic.ToolUseBlock[] = [];
    let textChunks: string[] = [];
    for (const block of resp.content) {
      if (block.type === "text") textChunks.push(block.text);
      else if (block.type === "tool_use") toolUses.push(block);
    }

    if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
      const finalText = textChunks.join("\n").trim();
      return finalText.length > MAX_TELEGRAM_CHARS
        ? finalText.slice(0, MAX_TELEGRAM_CHARS) + "\n\n_(truncated)_"
        : finalText || "(no response)";
    }

    // Execute tool_use blocks
    messages.push({ role: "assistant", content: resp.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await runTool(scope, use.name, use.input as Record<string, unknown>);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
      logger.debug({ tool: use.name, ok: result.ok }, "tool run");
    }

    messages.push({ role: "user", content: toolResults });
  }

  return `Sorry, I ran out of reasoning steps on that one. Try breaking it into smaller questions.`;
}
