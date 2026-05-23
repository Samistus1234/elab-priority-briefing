import type { KnowledgeUnit } from "./types.js";
import { findPii } from "./pii.js";

function extractJsonArray(raw: string): unknown[] {
  const fenced = raw.replace(/```json/gi, "```").split("```").map((s) => s.trim());
  const candidates = [raw, ...fenced];
  for (const c of candidates) {
    const start = c.indexOf("[");
    const end = c.lastIndexOf("]");
    if (start === -1 || end <= start) continue;
    try {
      const arr = JSON.parse(c.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch { /* try next */ }
  }
  return [];
}

function isValid(u: any): u is KnowledgeUnit {
  return (
    u && typeof u.topic === "string" && u.topic.trim() !== "" &&
    typeof u.question === "string" && u.question.trim() !== "" &&
    typeof u.answer === "string" && u.answer.trim() !== "" &&
    Array.isArray(u.tags) &&
    typeof u.confidence === "number" && u.confidence >= 0 && u.confidence <= 1
  );
}

export function parseUnits(raw: string): KnowledgeUnit[] {
  return extractJsonArray(raw)
    .filter(isValid)
    // PII safety net over ALL stored text fields (topic, question, answer, tags).
    .filter((u) => {
      const ku = u as KnowledgeUnit;
      return findPii([ku.topic, ku.question, ku.answer, ...ku.tags].join(" ")).length === 0;
    })
    .map((u) => u as KnowledgeUnit);
}
