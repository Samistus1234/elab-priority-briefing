export function buildThreadExtractionPrompt(transcript: string): string {
  return [
    "Below is one ELAB support EXCHANGE (a client conversation thread, a case's notes,",
    "or a help-desk ticket). Extract REUSABLE INTERNAL KNOWLEDGE a new staff member could",
    "rely on next time — what we tell clients, how we handle situations, process steps,",
    "policies, timelines, requirements.",
    "",
    'Return ONLY a JSON array: [{"topic":str,"question":str,"answer":str,"tags":[str],"confidence":0..1}]',
    'Example: {"topic":"DataFlow","question":"How long does Oman DataFlow take?","answer":"Typically 6-8 weeks; we update clients at submission and completion.","tags":["oman","dataflow","timeline"],"confidence":0.85}',
    "",
    "RULES:",
    "- Generalize to reusable know-how. Situational guidance is fine; a specific client's one-off status is not.",
    "- ABSOLUTELY NO PII anywhere (topic, question, answer, tags): no names, phones, emails, or case references.",
    "- confidence: 0.9 = explicit/clear policy or answer; 0.6 = reasonable inference; below that, omit.",
    "- If the exchange has nothing reusable, return [].",
    "",
    "EXCHANGE:",
    transcript,
  ].join("\n");
}
