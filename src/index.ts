// src/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, TextContent } from "@earendil-works/pi-ai";
import { createVisualServer, type VisualServer } from "./server.js";
import type { ClientMessage } from "./protocol.js";
import { createVisualTool } from "./tool.js";

interface VisualState {
  active: boolean;
  server: VisualServer | null;
  blocksRendered: number;
}

function isAssistantMessage(m: AgentMessage): boolean {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AgentMessage): string {
  if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const state: VisualState = {
    active: false,
    server: null,
    blocksRendered: 0,
  };

  function updateStatus(ctx: ExtensionContext, connected: boolean) {
    if (!state.active) {
      ctx.ui.setStatus("pi-visual", undefined);
      return;
    }
    ctx.ui.setStatus(
      "pi-visual",
      connected ? "visual: connected ●" : "visual: disconnected ○",
    );
  }

  async function startVisual(ctx: ExtensionContext): Promise<boolean> {
    if (state.active) return true;

    // Resolve spa directory relative to this file
    const thisFile = new URL(import.meta.url);
    const spaDir = new URL("../spa", thisFile).pathname;
    // On Windows, remove leading slash from file:///C:/...
    const normalizedSpaDir = process.platform === "win32" && spaDir.startsWith("/") ? spaDir.slice(1) : spaDir;

    try {
      const server = await createVisualServer(normalizedSpaDir);
      state.server = server;
      state.active = true;
      state.blocksRendered = 0;

      // Handle interactions from browser
      server.onInteraction = (msg: ClientMessage) => {
        if (msg.type === "interaction") {
          const actionText =
            msg.action === "select"
              ? `Selected: ${msg.value}`
              : msg.action === "toggle"
                ? `Toggled: ${msg.blockId}`
                : msg.action === "submit"
                  ? `Submitted: ${JSON.stringify(msg.values)}`
                  : `Interacted: ${msg.blockId}`;

          pi.sendUserMessage(`[visual] ${actionText}`, { deliverAs: "steer" });
        } else if (msg.type === "text") {
          // Echo user message to browser chat
          const images = msg.images?.length ? msg.images : undefined;
          server.pushUserChat(msg.text || "(image)", images);

          // Show thinking indicator
          server.pushThinkingStart();

          // Forward to pi
          const content: Array<{ type: string; text?: string; source?: { type: string; mediaType: string; data: string } }> = [];
          if (msg.text) {
            content.push({ type: "text", text: msg.text });
          }
          if (msg.images?.length) {
            for (const img of msg.images) {
              content.push({ type: "image", source: { type: "base64", mediaType: img.mediaType, data: img.data } });
            }
          }
          if (content.length > 0) {
            pi.sendUserMessage(content);
          }
        }
      };

      // Activate the visual tool
      pi.setActiveTools([...pi.getActiveTools(), "visual"]);
      updateStatus(ctx, true);

      // Open browser
      const openCmd =
        process.platform === "win32" ? "start"
        : process.platform === "darwin" ? "open"
        : "xdg-open";
      pi.exec(openCmd, [server.url]);

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      ctx.ui.notify(`[pi-visual] Error: ${message}\n${stack}`, "error");
      return false;
    }
  }

  function stopVisual(ctx?: ExtensionContext) {
    if (!state.active) return;

    state.server?.close();
    state.server = null;
    state.active = false;

    pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "visual"));
    if (ctx) updateStatus(ctx, false);
  }

  // Register /visual command
  pi.registerCommand("visual", {
    description: "Toggle visual mode on/off. Usage: /visual [on|off|status]",
    handler: async (args, ctx) => {
      const subCommand = args.trim().toLowerCase();

      if (subCommand === "on") {
        if (state.active) {
          ctx.ui.notify("Visual mode is already active", "info");
          return;
        }
        const ok = await startVisual(ctx);
        if (ok) {
          ctx.ui.notify(`Visual mode active — ${state.server?.url}`, "success");
        } else {
          ctx.ui.notify("Failed to start visual mode", "error");
        }
      } else if (subCommand === "off") {
        if (!state.active) {
          ctx.ui.notify("Visual mode is not active", "info");
          return;
        }
        stopVisual(ctx);
        ctx.ui.notify("Visual mode deactivated", "info");
      } else if (subCommand === "status") {
        if (!state.active) {
          ctx.ui.notify("Visual mode: inactive", "info");
        } else {
          ctx.ui.notify(
            `Visual mode: active\nURL: ${state.server?.url}\nBlocks rendered: ${state.blocksRendered}`,
            "info",
          );
        }
      } else {
        // Toggle
        if (state.active) {
          stopVisual(ctx);
          ctx.ui.notify("Visual mode deactivated", "info");
        } else {
          const ok = await startVisual(ctx);
          if (ok) {
            ctx.ui.notify(`Visual mode active — ${state.server?.url}`, "success");
          } else {
            ctx.ui.notify("Failed to start visual mode", "error");
          }
        }
      }
    },
  });

  // Register the visual tool
  const visualTool = createVisualTool(() => state);
  pi.registerTool(visualTool);

  // Capture assistant text responses and forward to browser
  pi.on("turn_end", async (event) => {
    if (!state.active || !state.server) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (text.trim()) {
      state.server.pushAssistantText(text);
    }
  });

  // End thinking on turn start (covers edge cases)
  pi.on("turn_start", async () => {
    if (!state.active || !state.server) return;
    state.server.pushThinkingEnd();
  });

  // Cleanup on session shutdown (no ctx available)
  pi.on("session_shutdown", async () => {
    if (state.active) {
      state.server?.close();
      state.server = null;
      state.active = false;
    }
  });
}
