export interface ParsedMessage {
  ts: string;
  sender: string;
  text: string;
}

// A message header: iOS "[2024-05-01, 10:23:45] Sender: " or Android "01/05/2024, 10:23 - Sender: ".
// Capture groups: 1=timestamp, 2=sender, 3=first-line text.
const IOS = /^\[([^\]]+)\]\s([^:]+?):\s?(.*)$/;
const ANDROID = /^([\d/.]+,\s[\d:apm\s]+?)\s-\s([^:]+?):\s?(.*)$/i;

const SYSTEM_PATTERNS = [
  /Messages and calls are end-to-end encrypted/i,
  /<Media omitted>|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted|Contact card omitted/i,
  /<This message was edited>/i,
  /This message was deleted|You deleted this message/i,
];

function stripMarks(s: string): string {
  // Strip LTR/RTL/format marks WhatsApp injects.
  return s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
}

function matchHeader(line: string): { ts: string; sender: string; text: string } | null {
  const m = IOS.exec(line) ?? ANDROID.exec(line);
  if (!m) return null;
  return { ts: m[1].trim(), sender: m[2].trim(), text: m[3] ?? "" };
}

/** Parse a WhatsApp "Export chat" .txt into messages. Pure; tolerant of iOS + Android formats. */
export function parseWhatsappExport(raw: string): ParsedMessage[] {
  const lines = stripMarks(raw).split(/\r?\n/);
  const out: ParsedMessage[] = [];
  let cur: ParsedMessage | null = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.text.trim();
    if (text && !SYSTEM_PATTERNS.some((re) => re.test(text))) out.push({ ...cur, text });
    cur = null;
  };

  for (const line of lines) {
    const h = matchHeader(line);
    if (h) {
      flush();
      cur = { ts: h.ts, sender: h.sender, text: h.text };
    } else if (cur) {
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  flush();
  return out;
}
