import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocket, type Data } from "ws";
import { createVisualServer } from "../src/server.js";

describe("createVisualServer", () => {
  let server: Awaited<ReturnType<typeof createVisualServer>> | null = null;

  afterEach(async () => {
    if (server) {
      server.close();
      server = null;
    }
  });

  /** Connect a WS client, drain initial "connected" message, return helpers */
  function connect(serverUrl: string) {
    const ws = new WebSocket(serverUrl);
    const messages: any[] = [];

    // Attach permanent message listener immediately (before open)
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    const ready = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    }).then(() => new Promise<void>((r) => setTimeout(r, 50))); // small delay to let initial messages arrive

    return {
      ws,
      messages,
      ready,
      /** Wait for a message of a given type to arrive */
      waitForType(type: string, timeout = 2000) {
        return new Promise<any>((resolve, reject) => {
          const existing = messages.find((m) => m.type === type);
          if (existing) return resolve(existing);
          const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
          const handler = (raw: Data) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === type) {
              clearTimeout(timer);
              resolve(msg);
            }
          };
          ws.on("message", handler);
        });
      },
    };
  }

  it("should start and return a port and url", async () => {
    server = await createVisualServer("./spa");
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${server.port}`);
  });

  it("should serve index.html on /", async () => {
    server = await createVisualServer("./spa");
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("pi visual");
  });

  it("should return 404 for missing files", async () => {
    server = await createVisualServer("./spa");
    const res = await fetch(`http://localhost:${server.port}/nonexistent.js`);
    expect(res.status).toBe(404);
  });

  it("should accept a WebSocket connection and send connected", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    // The first message should be "connected"
    expect(client.messages.some((m) => m.type === "connected")).toBe(true);
    client.ws.close();
  });

  it("should fire onConnect when a client connects", async () => {
    server = await createVisualServer("./spa");
    const connectSpy = vi.fn();
    server.onConnect = connectSpy;

    const client = connect(server.url);
    await client.ready;
    // Give a tick for the connection handler to call onConnect
    await new Promise((r) => setTimeout(r, 50));
    client.ws.close();

    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it("should replay chat history on reconnect", async () => {
    server = await createVisualServer("./spa");
    server.pushAssistantText("Hello from assistant");

    const client = connect(server.url);
    const historyMsg = await client.waitForType("history");
    client.ws.close();

    expect(historyMsg).toBeDefined();
    expect(historyMsg.items).toHaveLength(1);
    expect(historyMsg.items[0].type).toBe("assistant_chat");
    expect(historyMsg.items[0].text).toBe("Hello from assistant");
  });

  it("should receive messages pushed after connection", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushUserChat("test user message");
    const userMsg = await client.waitForType("user_chat");
    client.ws.close();

    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe("test user message");
    expect(userMsg.id).toMatch(/^user-\d+-\d+$/);
  });

  it("should handle clearBlocks and reset state", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    // Push items, then clear
    server.pushThinkingStart();
    server.pushWorkingStart();
    server.clearBlocks();

    // Now push assistant text — should NOT try to end thinking/working since they were cleared
    server.pushAssistantText("After clear");
    await client.waitForType("assistant_chat");
    client.ws.close();

    // thinking_end should not appear between clear and assistant_chat
    const types = client.messages.map((m) => m.type);
    const clearIdx = types.indexOf("clear");
    const assistantIdx = types.indexOf("assistant_chat");
    const slice = types.slice(clearIdx + 1, assistantIdx);
    expect(slice).not.toContain("thinking_end");
    expect(slice).not.toContain("working_end");
  });

  it("should generate unique IDs even in rapid succession", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    // Rapid-fire push multiple messages in the same tick
    for (let i = 0; i < 10; i++) {
      server.pushAssistantText(`Message ${i}`);
    }

    // Wait for all 10 assistant messages to arrive
    await new Promise((r) => setTimeout(r, 300));
    client.ws.close();

    const chatMsgs = client.messages.filter((m) => m.type === "assistant_chat");
    expect(chatMsgs).toHaveLength(10);
    const ids = chatMsgs.map((m) => m.id);

    // All IDs should be unique
    expect(new Set(ids).size).toBe(ids.length);

    // All IDs should follow the monotonic pattern
    for (const id of ids) {
      expect(id).toMatch(/^assistant-\d+-\d+$/);
    }
  });

  it("should route client text messages to onInteraction", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    client.ws.send(JSON.stringify({ type: "text", text: "Hello from browser" }));
    await new Promise((r) => setTimeout(r, 100));
    client.ws.close();

    expect(interactions).toHaveLength(1);
    expect(interactions[0].type).toBe("text");
    expect(interactions[0].text).toBe("Hello from browser");
  });

  it("should queue messages when onInteraction is null, then flush", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    // onInteraction is null by default, so messages should be queued
    client.ws.send(JSON.stringify({ type: "text", text: "queued message" }));
    await new Promise((r) => setTimeout(r, 100));

    // Now set the handler and flush
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);
    server.flushPending();
    client.ws.close();

    expect(interactions).toHaveLength(1);
    expect(interactions[0].text).toBe("queued message");
  });

  it("should handle tool call lifecycle", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushToolCallStart("tc-1", "bash", { command: "ls" });
    server.pushToolCallEnd("tc-1", "file1.txt\nfile2.txt", false);

    const startMsg = await client.waitForType("tool_call_start");
    const endMsg = await client.waitForType("tool_call_end");
    client.ws.close();

    expect(startMsg.toolName).toBe("bash");
    expect(startMsg.input).toEqual({ command: "ls" });

    expect(endMsg.id).toBe("tc-1");
    expect(endMsg.result).toBe("file1.txt\nfile2.txt");
    expect(endMsg.isError).toBe(false);
  });

  it("should handle multiple WebSocket clients", async () => {
    server = await createVisualServer("./spa");
    const client1 = connect(server.url);
    await client1.ready;

    // Connect second client — becomes activeWs
    const client2 = connect(server.url);
    await client2.ready;

    // Push a message — only client2 (activeWs) should receive it
    server.pushAssistantText("Only for client2");

    await client2.waitForType("assistant_chat");
    await new Promise((r) => setTimeout(r, 100)); // give client1 time to potentially receive

    client1.ws.close();
    client2.ws.close();

    // client1 should not receive the assistant message (it's no longer activeWs)
    expect(client1.messages.some((m) => m.type === "assistant_chat")).toBe(false);
    // client2 should receive it
    expect(client2.messages.some((m) => m.type === "assistant_chat")).toBe(true);
  });

  it("should end working indicator when tool call starts", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushWorkingStart();
    server.pushToolCallStart("tc-1", "read", { path: "/foo" });

    await client.waitForType("tool_call_start");
    client.ws.close();

    const types = client.messages.map((m) => m.type);
    const workingEndIdx = types.indexOf("working_end");
    const toolCallStartIdx = types.indexOf("tool_call_start");
    expect(workingEndIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallStartIdx).toBeGreaterThan(workingEndIdx);
  });

  it("should end thinking when assistant text is pushed", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushThinkingStart();
    server.pushAssistantText("Done thinking");

    await client.waitForType("assistant_chat");
    client.ws.close();

    const types = client.messages.map((m) => m.type);
    const thinkingStartIdx = types.indexOf("thinking_start");
    const thinkingEndIdx = types.indexOf("thinking_end");
    const assistantIdx = types.indexOf("assistant_chat");

    expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
    expect(assistantIdx).toBeGreaterThan(thinkingEndIdx);
  });

  it("should not duplicate thinking_end if pushAssistantText called twice", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushThinkingStart();
    server.pushAssistantText("First");
    server.pushAssistantText("Second"); // thinking already ended

    await client.waitForType("assistant_chat");
    await new Promise((r) => setTimeout(r, 50));
    client.ws.close();

    const thinkingEndCount = client.messages.filter((m) => m.type === "thinking_end").length;
    expect(thinkingEndCount).toBe(1); // Only one thinking_end
  });

  it("should push commands to connected client", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushCommands([{ name: "test", description: "A test command" }]);

    const cmdMsg = await client.waitForType("commands");
    client.ws.close();

    expect(cmdMsg.items).toHaveLength(1);
    expect(cmdMsg.items[0].name).toBe("test");
  });

  it("should push status info to connected client", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    server.pushStatus({ model: "gpt-4", cwd: "/home/user" });

    const statusMsg = await client.waitForType("status");
    client.ws.close();

    expect(statusMsg.model).toBe("gpt-4");
    expect(statusMsg.cwd).toBe("/home/user");
  });

  it("should handle pushBlocks and include blocks in history", async () => {
    server = await createVisualServer("./spa");

    server.pushBlocks("msg-1", [
      { id: "b1", type: "explanation", content: { title: "Test" } },
      { id: "b2", type: "code", content: { code: "hello" } },
    ]);

    // Connect and verify history replay includes blocks
    const client = connect(server.url);
    const historyMsg = await client.waitForType("history");
    client.ws.close();

    expect(historyMsg.items).toHaveLength(2);
    expect(historyMsg.items[0].type).toBe("block");
    expect(historyMsg.items[0].block.id).toBe("b1");
    expect(historyMsg.items[1].block.id).toBe("b2");
  });

  it("should handle malformed client messages gracefully", async () => {
    server = await createVisualServer("./spa");
    const client = connect(server.url);
    await client.ready;

    // Send invalid JSON
    client.ws.send("not json at all");
    await new Promise((r) => setTimeout(r, 100));

    // Should receive an error message back
    const errorMsg = client.messages.find((m) => m.type === "assistant_chat" && m.text?.includes("Server error"));
    expect(errorMsg).toBeDefined();
    client.ws.close();
  });
});
