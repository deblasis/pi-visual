// src/tool.ts
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Block, BlockType } from "./protocol.js";

interface VisualState {
  active: boolean;
  server: {
    port: number;
    url: string;
    pushBlocks: (id: string, blocks: Block[]) => void;
    updateBlock: (blockId: string, patch: Record<string, unknown>) => void;
    clearBlocks: () => void;
    onInteraction: ((msg: unknown) => void) | null;
  } | null;
  blocksRendered: number;
}

const BlockSchema = Type.Object({
  type: StringEnum([
    "tree", "table", "list",
    "flowchart", "steps", "state_machine",
    "comparison", "diff", "pros_cons",
    "chart", "timeline", "heatmap",
    "graph", "mind_map", "entity_relation",
    "choice", "form", "checklist",
    "explanation", "image", "svg", "code", "markdown",
  ] as const),
  content: Type.Any({ description: "Type-specific content data for this block" }),
  style: Type.Optional(Type.String({ description: "Optional Tailwind CSS classes for visual adjustments" })),
});

const VisualParams = Type.Object({
  blocks: Type.Array(BlockSchema, { description: "Array of visual blocks to render. Prefer 1-3 blocks per call." }),
  message: Type.Optional(Type.String({ description: "Optional short text acknowledgment" })),
});

type VisualParamsType = Static<typeof VisualParams>;

export function createVisualTool(getState: () => VisualState) {
  return {
    name: "visual",
    label: "Visual",
    description:
      `Render visual blocks in the user's browser. Each block has a type and content data.

Block types and their content shapes:
- explanation: { title, body } — Styled heading + paragraph card
- choice: { prompt, multi?, options: [{ value, title, description? }] } — Selectable cards. Single select is immediate, multi needs Submit.
- form: { fields: [{ name, type, label, required?, options? }] } — Input form. Queues until Submit.
- checklist: { items: [{ label, checked? }] } — Toggleable items. Immediate per toggle.
- code: { code, language } — Syntax-highlighted code block
- markdown: { content } — Rendered markdown
- image: { src, alt?, caption? } — Image with optional caption
- svg: { content } — SVG rendered in sandbox
- tree: { items: [{ label, children?, icon? }] } — Collapsible tree
- table: { headers, rows } — Data table
- list: { items: [{ label, badge?, icon? }] } — Styled list
- flowchart: { nodes: [{ id, label }], edges: [{ from, to, label? }] } — Flowchart diagram
- steps: { items: [{ title, description?, status? }] } — Ordered steps (status: done/current/pending)
- state_machine: { states: [{ id, label }], transitions: [{ from, to, trigger? }] } — State diagram
- comparison: { items: [{ title, attributes: {} }] } — Side-by-side comparison
- diff: { old, new, language } — Code diff (split view)
- pros_cons: { topic, pros: [], cons: [] } — Two-column pros/cons
- chart: { chartType, labels, datasets } — Chart (bar/line/pie/radar/scatter)
- timeline: { events: [{ date, title, description?, color? }] } — Vertical timeline
- heatmap: { data, xLabels, yLabels, colorRange? } — Color matrix
- graph: { nodes: [{ id, label }], edges: [{ from, to, label? }] } — Force-directed graph
- mind_map: { center, branches: [{ label, children? }] } — Radial mind map
- entity_relation: { entities: [{ id, label, attributes? }], relations: [{ from, to, type }] } — ER diagram

Guidelines:
- Prefer 1-3 blocks per call. Use explanation for text-heavy content.
- Use style sparingly (Tailwind classes) only for visual emphasis.
- For large data (tables, trees), send only what's needed for current context.`,
    promptSnippet: "Render visual blocks (diagrams, charts, choices) in the browser",
    promptGuidelines: [
      "Use the visual tool to render structured content instead of returning walls of text when visual mode is active.",
      "The visual tool renders blocks in the browser. Use explanation blocks for text, choice blocks for options, and diagram blocks (graph, flowchart, tree) for structure.",
      "After calling visual, do not emit another assistant response in the same turn.",
    ],
    parameters: VisualParams,

    async execute(
      _toolCallId: string,
      params: VisualParamsType,
      _signal: AbortSignal | undefined,
      _onUpdate: ((update: { content: Array<{ type: string; text: string }> }) => void) | undefined,
      _ctx: unknown,
    ) {
      const state = getState();

      if (!state.active || !state.server) {
        throw new Error("Visual mode is not active. Use /visual to enable it.");
      }

      // Resolve local file paths in image blocks to data URIs
      const resolvedBlocks = await Promise.all(params.blocks.map(async (block) => {
        if (block.type === "image" && block.content?.src) {
          const src: string = block.content.src;
          if (!src.startsWith("data:") && !src.startsWith("http:") && !src.startsWith("https:")) {
            try {
              const filePath = src.startsWith("file:///") ? new URL(src).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)) : src;
              const data = await readFile(filePath);
              const ext = extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp" };
              const mime = mimeMap[ext] || "image/png";
              return { ...block, content: { ...block.content, src: `data:${mime};base64,${data.toString("base64")}` } };
            } catch { /* leave src as-is */ }
          }
        }
        return block;
      }));

      const now = Date.now();
      const blocksWithIds: Block[] = resolvedBlocks.map((block, i) => ({
        id: `block-${now}-${i}`,
        type: block.type as BlockType,
        content: block.content,
        ...(block.style ? { style: block.style } : {}),
      }));

      const messageId = `msg-${now}`;
      state.server.pushBlocks(messageId, blocksWithIds);
      state.blocksRendered += blocksWithIds.length;

      return {
        content: [
          {
            type: "text" as const,
            text: params.message || `Rendered ${blocksWithIds.length} block(s) in browser`,
          },
        ],
        details: {
          blockCount: blocksWithIds.length,
          blockTypes: blocksWithIds.map((b) => b.type),
        },
        terminate: true,
      };
    },

    renderCall(args: VisualParamsType, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }) {
      const types = args.blocks.map((b) => b.type).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("visual ")) + theme.fg("muted", `${args.blocks.length} block(s): ${types}`),
        0,
        0,
      );
    },

    renderResult(
      result: { content: Array<{ type: string; text: string }> },
      _options: unknown,
      theme: { fg: (color: string, text: string) => string },
    ) {
      const text = result.content[0];
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.text || "Rendered"), 0, 0);
    },
  };
}
