// src/protocol.ts
// Shared message types for WebSocket communication between extension and SPA

// ─── Block types ───

export const BLOCK_TYPES = [
  // Structure
  "tree", "table", "list",
  // Process
  "flowchart", "steps", "state_machine",
  // Comparison
  "comparison", "diff", "pros_cons",
  // Data viz
  "chart", "timeline", "heatmap",
  // Relationships
  "graph", "mind_map", "entity_relation",
  // Interaction
  "choice", "form", "checklist",
  // Media
  "explanation", "image", "svg", "code", "markdown",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export interface Block {
  id: string;
  type: BlockType;
  content: unknown;
  style?: string;
}

// ─── Server → Browser messages ───

export interface BlocksMessage {
  type: "blocks";
  id: string;
  blocks: Block[];
}

export interface UpdateMessage {
  type: "update";
  blockId: string;
  patch: Record<string, unknown>;
}

export interface ClearMessage {
  type: "clear";
}

export type ServerMessage = BlocksMessage | UpdateMessage | ClearMessage;

// ─── Browser → Server messages ───

export interface InteractionMessage {
  type: "interaction";
  blockId: string;
  action: "select" | "submit" | "toggle" | "text";
  value?: string;
  values?: Record<string, unknown>;
}

export interface TextInputMessage {
  type: "text";
  text: string;
  images?: Array<{ mediaType: string; data: string }>;
}

export type ClientMessage = InteractionMessage | TextInputMessage;

// ─── Connection messages ───

export interface HistoryResponse {
  type: "history";
  blocks: Block[];
}
