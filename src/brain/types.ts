export interface KnowledgeUnit {
  topic: string;
  question: string;
  answer: string;
  tags: string[];
  confidence: number; // 0..1
}

export interface SourceRef {
  source: string; // 'whatsapp' | 'ticket' | 'case_note'
  id: string;     // source row id
}

export type EntryStatus = "published" | "pending" | "archived";
