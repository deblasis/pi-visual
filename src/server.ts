// src/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, Block, HistoryResponse } from "./protocol.js";

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
  onInteraction: ((msg: ClientMessage) => void) | null;
}

export function createVisualServer(spaDir: string): Promise<VisualServer> {
  return new Promise((resolve, reject) => {
    const blockHistory: Block[] = [];
    let activeWs: WebSocket | null = null;

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

      const historyMsg: HistoryResponse = { type: "history", blocks: blockHistory };
      ws.send(JSON.stringify(historyMsg));

      ws.on("message", (raw: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          if (msg.type === "interaction" || msg.type === "text") {
            serverObj.onInteraction?.(msg);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        if (activeWs === ws) activeWs = null;
      });
    });

    let attempts = 0;
    const maxAttempts = 5;

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
        attempts++;
        httpServer.listen(0, "127.0.0.1", handleListen);
      } else {
        reject(err);
      }
    });

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
        blockHistory.push(...blocks);
        const msg = { type: "blocks" as const, id, blocks };
        activeWs?.send(JSON.stringify(msg));
      },
      updateBlock(blockId: string, patch: Record<string, unknown>) {
        const msg = { type: "update" as const, blockId, patch };
        activeWs?.send(JSON.stringify(msg));
      },
      clearBlocks() {
        blockHistory.length = 0;
        activeWs?.send(JSON.stringify({ type: "clear" }));
      },
      onInteraction: null,
    });

    tryListen();
  });
}
