// src/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, Block, ChatItem } from "./protocol.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface VisualServer {
  port: number;
  url: string;
  close: () => void;
  pushBlocks: (id: string, blocks: Block[]) => void;
  updateBlock: (blockId: string, patch: Record<string, unknown>) => void;
  clearBlocks: () => void;
  pushUserChat: (text: string, images?: Array<{ mediaType: string; data: string }>) => void;
  pushAssistantText: (text: string) => void;
  pushThinkingStart: () => void;
  pushThinkingEnd: () => void;
  pushWorkingStart: () => void;
  pushWorkingEnd: () => void;
  pushToolCallStart: (id: string, toolName: string, input: Record<string, unknown>) => void;
  pushToolCallEnd: (id: string, result?: string, isError?: boolean) => void;
  onInteraction: ((msg: ClientMessage) => void) | null;
}

export function createVisualServer(spaDir: string): Promise<VisualServer> {
  return new Promise((resolve, reject) => {
    const history: ChatItem[] = [];
    let activeWs: WebSocket | null = null;
    let thinkingId: string | null = null;
    let workingId: string | null = null;

    function send(msg: object) {
      if (activeWs?.readyState === 1) activeWs.send(JSON.stringify(msg));
    }

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const urlPath = req.url === "/" ? "/index.html" : req.url!.split("?")[0];
      const filePath = join(spaDir, urlPath);

      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws: WebSocket) => {
      activeWs = ws;
      ws.send(JSON.stringify({ type: "connected" }));

      // Replay full chat history
      if (history.length > 0) {
        ws.send(JSON.stringify({ type: "history", items: history }));
      }

      ws.on("message", (raw: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          console.log("[pi-visual] WS received:", JSON.stringify(msg).substring(0, 200));
          if (msg.type === "interaction" || msg.type === "text") {
            if (!serverObj.onInteraction) {
              console.error("[pi-visual] ERROR: onInteraction is not set!");
              send({ type: "assistant_chat", id: `error-${Date.now()}`, text: "[pi-visual] Error: onInteraction handler not registered" });
              return;
            }
            serverObj.onInteraction(msg);
            console.log("[pi-visual] onInteraction called successfully");
          }
        } catch (err) {
          console.error("[pi-visual] WS message error:", err);
          const errMsg = err instanceof Error ? err.message : String(err);
          send({ type: "assistant_chat", id: `error-${Date.now()}`, text: `[pi-visual] Server error: ${errMsg}` });
        }
      });

      ws.on("close", () => {
        if (activeWs === ws) activeWs = null;
      });
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
        attempts++;
        httpServer.listen(0, "127.0.0.1", handleListen);
      } else {
        reject(err);
      }
    });

    let attempts = 0;
    const maxAttempts = 5;

    function handleListen() {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        resolve(serverObj(addr.port));
      } else {
        reject(new Error("Failed to get server port"));
      }
    }

    httpServer.listen(0, "127.0.0.1", handleListen);

    const serverObj = (port: number): VisualServer => ({
      port,
      url: `http://localhost:${port}`,
      close() {
        wss.close();
        httpServer.close();
      },
      pushBlocks(id: string, blocks: Block[]) {
        for (const block of blocks) {
          const item: ChatItem = { type: "block", id: block.id, block };
          history.push(item);
        }
        send({ type: "blocks", id, blocks });
      },
      updateBlock(blockId: string, patch: Record<string, unknown>) {
        send({ type: "update", blockId, patch });
      },
      clearBlocks() {
        history.length = 0;
        send({ type: "clear" });
      },
      pushUserChat(text: string, images?: Array<{ mediaType: string; data: string }>) {
        const id = `user-${Date.now()}`;
        const item: ChatItem = { type: "user_chat", id, text, ...(images?.length ? { images } : {}) };
        history.push(item);
        send({ type: "user_chat", id, text, ...(images?.length ? { images } : {}) });
      },
      pushAssistantText(text: string) {
        // End thinking if active
        if (thinkingId) {
          send({ type: "thinking_end", id: thinkingId });
          const idx = history.findIndex(h => h.id === thinkingId);
          if (idx >= 0) history.splice(idx, 1);
          thinkingId = null;
        }
        // End working if active
        if (workingId) {
          send({ type: "working_end" });
          workingId = null;
        }

        const id = `assistant-${Date.now()}`;
        const item: ChatItem = { type: "assistant_chat", id, text };
        history.push(item);
        send({ type: "assistant_chat", id, text });
      },
      pushThinkingStart() {
        if (thinkingId) return; // Already thinking
        thinkingId = `thinking-${Date.now()}`;
        const item: ChatItem = { type: "thinking", id: thinkingId };
        history.push(item);
        send({ type: "thinking_start", id: thinkingId });
      },
      pushThinkingEnd() {
        if (!thinkingId) return;
        send({ type: "thinking_end", id: thinkingId });
        const idx = history.findIndex(h => h.id === thinkingId);
        if (idx >= 0) history.splice(idx, 1);
        thinkingId = null;
      },
      pushWorkingStart() {
        if (workingId) return;
        workingId = `working-${Date.now()}`;
        send({ type: "working_start", id: workingId });
      },
      pushWorkingEnd() {
        if (!workingId) return;
        send({ type: "working_end" });
        workingId = null;
      },
      pushToolCallStart(id: string, toolName: string, input: Record<string, unknown>) {
        // End working indicator if active
        if (workingId) {
          send({ type: "working_end" });
          workingId = null;
        }
        const item: ChatItem = { type: "tool_call", id, toolName, input };
        history.push(item);
        send({ type: "tool_call_start", id, toolName, input });
      },
      pushToolCallEnd(id: string, result?: string, isError?: boolean) {
        // Update history item
        const item = history.find(h => h.type === "tool_call" && h.id === id);
        if (item && item.type === "tool_call") {
          item.result = result;
          item.isError = isError;
        }
        send({ type: "tool_call_end", id, result, isError });
      },
      onInteraction: null,
    });
  });
}
