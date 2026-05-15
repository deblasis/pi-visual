// src/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, TextContent, ImageContent } from "@earendil-works/pi-ai";
import { createVisualServer, type VisualServer } from "./server.js";
import type { ClientMessage } from "./protocol.js";
import { createVisualTool } from "./tool.js";
import * as debug from "./debug.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

interface PortlessInfo {
  hostname: string;
  url: string;
  routeStore: any;
}

interface VisualState {
  active: boolean;
  server: VisualServer | null;
  blocksRendered: number;
  portlessInfo: PortlessInfo | null;
  model: string | null;
  cwd: string | null;
  sessionId: string | null;
}

const BUILTIN_COMMANDS = [
  { name: "model", description: "Switch or cycle AI model" },
  { name: "compact", description: "Compact conversation history" },
  { name: "clear", description: "Clear conversation" },
  { name: "help", description: "Show available commands" },
  { name: "reload", description: "Reload extensions" },
  { name: "settings", description: "Open settings" },
  { name: "undo", description: "Undo last turn" },
  { name: "copy", description: "Copy last response" },
  { name: "branch", description: "Create conversation branch" },
  { name: "cost", description: "Show session cost" },
];

async function getPortlessInfo(port: number, cwd: string, sessionId: string): Promise<PortlessInfo | null> {
  const portlessDir = join(homedir(), ".portless");
  debug.log("getPortlessInfo: checking", portlessDir, "exists:", existsSync(portlessDir));
  if (!existsSync(portlessDir)) return null;

  try {
    debug.log("getPortlessInfo: attempting dynamic import of portless");
    let portlessModule: any;
    try {
      portlessModule = await import("portless");
    } catch {
      // Fallback: try resolving from global node_modules
      debug.log("getPortlessInfo: direct import failed, trying global resolution");
      const { execSync } = await import("node:child_process");
      try {
        const globalPrefix = execSync("npm root -g", { encoding: "utf8" }).trim();
        const globalPath = join(globalPrefix, "portless");
        debug.log("getPortlessInfo: trying global path", globalPath, "exists:", existsSync(globalPath));
        if (existsSync(globalPath)) {
          portlessModule = await import(globalPath);
        } else {
          throw new Error(`portless not found at ${globalPath}`);
        }
      } catch (globalErr) {
        debug.log("getPortlessInfo: global resolution also failed:", globalErr);
        throw globalErr;
      }
    }
    const { RouteStore, parseHostname } = portlessModule;
    debug.log("getPortlessInfo: import succeeded, RouteStore:", !!RouteStore, "parseHostname:", !!parseHostname);

    const folder = cwd.split(/[/\\]/).pop() || "unknown";
    const sanitized = folder.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const sessionPrefix = (sessionId || "xxxx").substring(0, 4);
    const rawHostname = `pi-chat-${sanitized}-${sessionPrefix}`;
    const hostname = parseHostname(rawHostname);

    const store = new RouteStore(portlessDir);
    store.ensureDir();
    store.addRoute(hostname, port, process.pid);

    const proxyPort = parseInt(readFileSync(join(portlessDir, "proxy.port"), "utf8").trim(), 10);
    const tlsEnabled = readFileSync(join(portlessDir, "proxy.tls"), "utf8").trim() === "1";
    const protocol = tlsEnabled ? "https" : "http";
    const defaultPort = tlsEnabled ? 443 : 80;
    const portSuffix = proxyPort === defaultPort ? "" : `:${proxyPort}`;
    const url = `${protocol}://${hostname}${portSuffix}`;

    debug.log("Portless route registered:", hostname, "→ port", port, "url:", url);
    return { hostname, url, routeStore: store };
  } catch (err) {
    debug.warn("Portless integration failed, falling back to localhost:", err);
    return null;
  }
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
    portlessInfo: null,
    model: null,
    cwd: null,
    sessionId: null,
  };

  function pushCommands() {
    if (!state.server) return;
    try {
      const ext = pi.getCommands().map((c) => ({ name: c.name, description: c.description }));
      state.server.pushCommands([...BUILTIN_COMMANDS, ...ext]);
    } catch {
      state.server.pushCommands(BUILTIN_COMMANDS);
    }
  }

  function pushStatus() {
    if (!state.server) return;
    state.server.pushStatus({
      model: state.model || undefined,
      cwd: state.cwd || undefined,
      sessionId: state.sessionId || undefined,
    });
  }

  function updateStatus(ctx: ExtensionContext, connected: boolean) {
    if (!state.active) {
      ctx.ui.setStatus("pi-visual", undefined);
      return;
    }
    const url = state.portlessInfo?.url || state.server?.url || "";
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
      server.onConnect = () => {
        debug.log("Browser connected, pushing commands + status");
        pushCommands();
        pushStatus();
      };
      server.onInteraction = async (msg: ClientMessage) => {
        try {
          const msgPreview = { ...msg };
          if (msgPreview.images) msgPreview.images = [`[${msgPreview.images?.length ?? 0} image(s)]`];
          debug.log("onInteraction:", JSON.stringify(msgPreview));

          if (msg.type === "interaction") {
            const actionText =
              msg.action === "select"
                ? `Selected: ${msg.value}`
                : msg.action === "toggle"
                  ? `Toggled: ${msg.blockId}`
                  : msg.action === "submit"
                    ? `Submitted: ${JSON.stringify(msg.values)}`
                    : `Interacted: ${msg.blockId}`;

            debug.log("Sending interaction as steer:", actionText);
            await pi.sendUserMessage(`[visual] ${actionText}`, { deliverAs: "steer" });
          } else if (msg.type === "text") {
            // Echo user message to browser chat
            const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
            const images = hasImages ? msg.images : undefined;
            debug.log("pushUserChat, text:", (msg.text || "").substring(0, 50), "images:", images?.length ?? 0, "hasImages:", hasImages);
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
                const imgData = img.data || "";
                const imgMime = img.mediaType || "image/png";
                debug.log("  image item: mimeType=", imgMime, "dataLength=", imgData.length);
                content.push({ type: "image", data: imgData, mimeType: imgMime });
              }
              debug.log("sendUserMessage multimodal, items:", content.length, "totalBytes:", content.reduce((s, c) => s + (c.type === "image" ? c.data.length : 0), 0));
              await pi.sendUserMessage(content);
            } else if (msg.text) {
              debug.log("sendUserMessage text:", msg.text.substring(0, 100));
              await pi.sendUserMessage(msg.text);
            } else {
              debug.warn("No text or images to send");
            }
          }
        } catch (err) {
          debug.error("onInteraction ERROR:", err);
          const errMsg = err instanceof Error ? err.message : String(err);
          server.pushThinkingEnd();
          server.pushAssistantText(`[pi-visual] Error: ${errMsg}`);
        }
      };

      // Flush any messages that arrived before the handler was set
      server.flushPending();

      // Capture context info for status bar
      state.cwd = ctx.cwd;
      state.sessionId = ctx.sessionManager.getSessionId();
      state.model = ctx.model?.id ?? null;

      // Push commands + status after server is up
      pushCommands();
      pushStatus();

      // Activate the visual tool
      pi.setActiveTools([...pi.getActiveTools(), "visual"]);

      // Open browser immediately with localhost URL
      updateStatus(ctx, true);
      debug.log("Opening browser to:", server.url);

      const openCmd =
        process.platform === "win32" ? "start"
        : process.platform === "darwin" ? "open"
        : "xdg-open";
      pi.exec(openCmd, [server.url]);

      // Detect portless asynchronously — ask user if found
      const folderName = ctx.cwd.split(/[/\\]/).pop() || "unknown";
      const sessionId = ctx.sessionManager.getSessionId();
      getPortlessInfo(server.port, folderName, sessionId)
        .then(async (portlessInfo) => {
          if (!portlessInfo || !state.active) return;
          debug.log("portlessInfo result:", portlessInfo.url, "hasUI:", ctx.hasUI);
          let usePortless = false;
          if (ctx.hasUI) {
            debug.log("Asking user about portless...");
            usePortless = (await ctx.ui.confirm(
              "Portless detected",
              `Use portless URL? ${portlessInfo.url} (instead of ${server.url})`,
            )) ?? false;
            debug.log("User chose portless:", usePortless);
          } else {
            debug.log("No UI available, skipping portless confirm");
          }
          if (usePortless) {
            state.portlessInfo = portlessInfo;
            updateStatus(ctx, true);
            ctx.ui.notify(`Switched to portless: ${portlessInfo.url}`, "success");
          }
        })
        .catch((err) => {
          debug.warn("Portless detection failed:", err);
        });

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

    // Remove portless route
    if (state.portlessInfo) {
      try {
        state.portlessInfo.routeStore.removeRoute(state.portlessInfo.hostname);
        debug.log("Portless route removed:", state.portlessInfo.hostname);
      } catch (err) {
        debug.warn("Failed to remove portless route:", err);
      }
      state.portlessInfo = null;
    }

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
          ctx.ui.notify(`Visual mode active — ${state.portlessInfo?.url || state.server?.url}`, "success");
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
            `Visual mode: active\nURL: ${state.portlessInfo?.url || state.server?.url}\nFallback: ${state.server?.url}\nBlocks rendered: ${state.blocksRendered}`,
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
            ctx.ui.notify(`Visual mode active — ${state.portlessInfo?.url || state.server?.url}`, "success");
          } else {
            ctx.ui.notify("Failed to start visual mode", "error");
          }
        }
      }
    },
  });

  // Register the visual tool (but deactivate immediately — pi auto-activates all extension tools)
  const visualTool = createVisualTool(() => state);
  pi.registerTool(visualTool);
  // Defer setActiveTools to avoid calling action method during extension loading
  setTimeout(() => {
    pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "visual"));
  }, 0);

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
    debug.log("turn_start");
    state.server.pushThinkingEnd();
    state.server.pushWorkingStart();
  });

  pi.on("tool_execution_start", async (event) => {
    if (!state.active || !state.server) return;
    debug.log("tool_execution_start:", event.toolName, event.toolCallId);
    state.server.pushToolCallStart(event.toolCallId, event.toolName, event.args ?? {});
  });

  pi.on("tool_execution_end", async (event) => {
    if (!state.active || !state.server) return;
    debug.log("tool_execution_end:", event.toolName, event.toolCallId, "isError:", event.isError);
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
    debug.log("turn_end, role:", event.message.role);
    state.server.pushWorkingEnd();
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    const images = getImages(event.message);
    if (text.trim() || images.length > 0) {
      state.server.pushAssistantText(text, images.length > 0 ? images : undefined);
    }
  });

  // Update status bar when model changes
  pi.on("model_select", async (event) => {
    state.model = event.model?.id ?? null;
    pushStatus();
  });

  // Cleanup on session shutdown (no ctx available)
  pi.on("session_shutdown", async () => {
    if (state.active) {
      if (state.portlessInfo) {
        try {
          state.portlessInfo.routeStore.removeRoute(state.portlessInfo.hostname);
        } catch {}
        state.portlessInfo = null;
      }
      state.server?.close();
      state.server = null;
      state.active = false;
    }
  });
}
