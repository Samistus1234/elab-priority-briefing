export interface KnowledgeUnit {
  topic: string;
  question: string;
  answer: string;
  tags: string[];
  confidence: number; // 0..1
}

export interface SourceRef {
  source: string; // v1.1 group sources: 'whatsapp_convo' | 'case' | 'ticket'
  id: string;     // the group id (conversation_id | case_id | ticket id)
}

export type EntryStatus = "published" | "pending" | "archived";
