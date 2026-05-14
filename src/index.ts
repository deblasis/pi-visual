// src/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, TextContent, ImageContent } from "@earendil-works/pi-ai";
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

function getImages(message: AgentMessage): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is ImageContent => block.type === "image")
    .map((block) => ({ mimeType: block.mimeType, data: block.data }));
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
    const url = state.server?.url || "";
    ctx.ui.setStatus(
      "pi-visual",
      connected ? `pi-visual: connected ● ${url}` : "pi-visual: disconnected ○",
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
        try {
          const msgPreview = { ...msg };
          if (msgPreview.images) msgPreview.images = [`[${msg.images.length} image(s)]`];
          console.log("[pi-visual] onInteraction:", JSON.stringify(msgPreview));

          if (msg.type === "interaction") {
            const actionText =
              msg.action === "select"
                ? `Selected: ${msg.value}`
                : msg.action === "toggle"
                  ? `Toggled: ${msg.blockId}`
                  : msg.action === "submit"
                    ? `Submitted: ${JSON.stringify(msg.values)}`
                    : `Interacted: ${msg.blockId}`;

            console.log("[pi-visual] Sending interaction as steer:", actionText);
            pi.sendUserMessage(`[visual] ${actionText}`, { deliverAs: "steer" });
            console.log("[pi-visual] sendUserMessage (interaction) OK");
          } else if (msg.type === "text") {
            // Echo user message to browser chat
            const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
            const images = hasImages ? msg.images : undefined;
            console.log("[pi-visual] pushUserChat, text:", (msg.text || "").substring(0, 50), "images:", images?.length ?? 0);
            server.pushUserChat(msg.text || "(image)", images);

            // Show thinking indicator
            server.pushThinkingStart();

            // Forward to pi
            if (hasImages) {
              const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
              if (msg.text) {
                content.push({ type: "text", text: msg.text });
              }
              for (const img of msg.images) {
                content.push({ type: "image", data: img.data || "", mimeType: img.mediaType || "image/png" });
              }
              console.log("[pi-visual] Calling sendUserMessage with multimodal, items:", content.length);
              pi.sendUserMessage(content);
              console.log("[pi-visual] sendUserMessage (multimodal) OK");
            } else if (msg.text) {
              console.log("[pi-visual] Calling sendUserMessage with text:", msg.text.substring(0, 100));
              pi.sendUserMessage(msg.text);
              console.log("[pi-visual] sendUserMessage (text) OK");
            } else {
              console.warn("[pi-visual] No text or images to send");
            }
          }
        } catch (err) {
          console.error("[pi-visual] onInteraction ERROR:", err);
          const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
          server.pushAssistantText(`[pi-visual] Error: ${errMsg}`);
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

  // Forward terminal input to web UI
  pi.on("input", async (event) => {
    if (!state.active || !state.server) return;
    // Only forward input typed in the terminal (not from our own extension)
    if (event.source !== "interactive") return;
    const images = event.images?.length
      ? event.images.map(img => ({ mimeType: img.mimeType, data: img.data }))
      : undefined;
    state.server.pushTerminalChat(event.text, images);
  });

  // Capture assistant text responses and forward to browser
  pi.on("turn_start", async () => {
    if (!state.active || !state.server) return;
    console.log("[pi-visual] turn_start");
    state.server.pushThinkingEnd();
    state.server.pushWorkingStart();
  });

  pi.on("tool_execution_start", async (event) => {
    if (!state.active || !state.server) return;
    console.log("[pi-visual] tool_execution_start:", event.toolName, event.toolCallId);
    state.server.pushToolCallStart(event.toolCallId, event.toolName, event.args ?? {});
  });

  pi.on("tool_execution_end", async (event) => {
    if (!state.active || !state.server) return;
    console.log("[pi-visual] tool_execution_end:", event.toolName, event.toolCallId, "isError:", event.isError);
    const result = event.result;
    let resultText = "";
    if (result?.content && Array.isArray(result.content)) {
      resultText = result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n");
    }
    state.server.pushToolCallEnd(event.toolCallId, resultText || undefined, event.isError);
    state.server.pushWorkingStart();
  });

  pi.on("turn_end", async (event) => {
    if (!state.active || !state.server) return;
    console.log("[pi-visual] turn_end, role:", event.message.role);
    state.server.pushWorkingEnd();
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    const images = getImages(event.message);
    if (text.trim() || images.length > 0) {
      state.server.pushAssistantText(text, images.length > 0 ? images : undefined);
    }
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
