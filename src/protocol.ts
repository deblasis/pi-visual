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

// ─── Chat message types ───

export interface UserChatItem {
  type: "user_chat";
  id: string;
  text: string;
  images?: Array<{ mediaType: string; data: string }>;
}

export interface AssistantChatItem {
  type: "assistant_chat";
  id: string;
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
}

export interface ThinkingItem {
  type: "thinking";
  id: string;
}

export interface BlockChatItem {
  type: "block";
  id: string;
  block: Block;
}

export interface ToolCallChatItem {
  type: "tool_call";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export type ChatItem = UserChatItem | AssistantChatItem | ThinkingItem | BlockChatItem | ToolCallChatItem;

// ─── Server → Browser messages ───

export interface HistoryMessage {
  type: "history";
  items: ChatItem[];
}

export interface BlocksMessage {
  type: "blocks";
  id: string;
  blocks: Block[];
}

export interface UserChatMessage {
  type: "user_chat";
  id: string;
  text: string;
  images?: Array<{ mediaType: string; data: string }>;
}

export interface AssistantChatMessage {
  type: "assistant_chat";
  id: string;
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
}

export interface ThinkingStartMessage {
  type: "thinking_start";
  id: string;
}

export interface ThinkingEndMessage {
  type: "thinking_end";
  id: string;
}

export interface UpdateMessage {
  type: "update";
  blockId: string;
  patch: Record<string, unknown>;
}

export interface ClearMessage {
  type: "clear";
}

export interface ToolCallStartMessage {
  type: "tool_call_start";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolCallEndMessage {
  type: "tool_call_end";
  id: string;
  result?: string;
  isError?: boolean;
}

export interface WorkingStartMessage {
  type: "working_start";
  id: string;
}

export interface WorkingEndMessage {
  type: "working_end";
}

export type ServerMessage =
  | HistoryMessage
  | BlocksMessage
  | UserChatMessage
  | AssistantChatMessage
  | ThinkingStartMessage
  | ThinkingEndMessage
  | ToolCallStartMessage
  | ToolCallEndMessage
  | WorkingStartMessage
  | WorkingEndMessage
  | UpdateMessage
  | ClearMessage;

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
