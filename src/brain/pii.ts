// Detects + scrubs obvious PII as a safety net over LLM output.
// Phone candidates must contain >=10 real digits, so ISO dates (2024-01-15 = 8
// digits) and short doc refs (INV-2024-00123 = 9) are NOT false-flagged, while
// real numbers (+2348012345678, 0801-234-5678, (801) 234-5678) are caught.
// Regexes are used only via stateless .test() (non-global) / .match() / .replace(),
// so there is no lastIndex state to manage between calls.
const PHONE_RUN = /\+?\d[\d\s().-]{7,}\d/g;

function isPhone(run: string): boolean {
  return run.replace(/\D/g, "").length >= 10;
}

export function findPii(text: string): string[] {
  const hits: string[] = [];
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) hits.push("email");
  if ((text.match(PHONE_RUN) ?? []).some(isPhone)) hits.push("phone");
  return hits;
}

export function scrubPii(text: string): string {
  return text
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted]")
    .replace(PHONE_RUN, (m) => (isPhone(m) ? "[redacted]" : m));
}
