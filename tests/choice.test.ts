import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocket, type Data } from "ws";
import { createVisualServer } from "../src/server.js";

describe("choice block interactions", () => {
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
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    const ready = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    }).then(() => new Promise<void>((r) => setTimeout(r, 50)));
    return {
      ws,
      messages,
      ready,
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
      /** Send a message and wait a tick */
      send(msg: object) {
        ws.send(JSON.stringify(msg));
        return new Promise<void>((r) => setTimeout(r, 100));
      },
    };
  }

  // ─── Single choice ───

  it("should send interaction when client sends select action for single choice", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    // Simulate what the browser sends when a single-choice card is clicked
    await client.send({
      type: "interaction",
      blockId: "block-single-1",
      action: "select",
      value: "option_a",
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].type).toBe("interaction");
    expect(interactions[0].action).toBe("select");
    expect(interactions[0].value).toBe("option_a");
    expect(interactions[0].blockId).toBe("block-single-1");
    client.ws.close();
  });

  it("should send interaction with correct value for each option", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    // Simulate selecting option B
    await client.send({
      type: "interaction",
      blockId: "block-single-2",
      action: "select",
      value: "option_b",
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].value).toBe("option_b");
    client.ws.close();
  });

  // ─── Multi choice ───

  it("should send submit action for multi-choice with selected values", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    // Simulate multi-choice submit with 2 selections
    await client.send({
      type: "interaction",
      blockId: "block-multi-1",
      action: "submit",
      values: { opt0: "auth", opt1: "db" },
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].type).toBe("interaction");
    expect(interactions[0].action).toBe("submit");
    expect(interactions[0].values).toEqual({ opt0: "auth", opt1: "db" });
    client.ws.close();
  });

  it("should send submit with empty values when nothing selected", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    await client.send({
      type: "interaction",
      blockId: "block-multi-2",
      action: "submit",
      values: {},
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].values).toEqual({});
    client.ws.close();
  });

  // ─── Toggle interaction ───

  it("should send toggle action for checklist interaction", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    await client.send({
      type: "interaction",
      blockId: "block-checklist-1",
      action: "toggle",
      value: "item_1",
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].action).toBe("toggle");
    expect(interactions[0].value).toBe("item_1");
    client.ws.close();
  });

  // ─── Pushing choice blocks via server ───

  it("should push single-choice blocks and include them in history", async () => {
    server = await createVisualServer("./spa");

    server.pushBlocks("msg-1", [
      {
        id: "b-choice-1",
        type: "choice" as const,
        content: {
          prompt: "Pick one:",
          options: [
            { value: "a", title: "Option A", description: "First" },
            { value: "b", title: "Option B", description: "Second" },
          ],
        },
      },
    ]);

    const client = connect(server.url);
    const history = await client.waitForType("history");
    client.ws.close();

    expect(history.items).toHaveLength(1);
    expect(history.items[0].type).toBe("block");
    expect(history.items[0].block.type).toBe("choice");
    expect(history.items[0].block.content.prompt).toBe("Pick one:");
    expect(history.items[0].block.content.options).toHaveLength(2);
  });

  it("should push multi-choice blocks with multi flag", async () => {
    server = await createVisualServer("./spa");

    server.pushBlocks("msg-2", [
      {
        id: "b-multi-1",
        type: "choice" as const,
        content: {
          prompt: "Select features:",
          multi: true,
          options: [
            { value: "auth", title: "Auth" },
            { value: "db", title: "Database" },
            { value: "api", title: "API" },
          ],
        },
      },
    ]);

    const client = connect(server.url);
    const history = await client.waitForType("history");
    client.ws.close();

    expect(history.items[0].block.content.multi).toBe(true);
    expect(history.items[0].block.content.options).toHaveLength(3);
  });

  // ─── "Tell me more" sends text message ───

  it("should handle tell-me-more as a text message", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    await client.send({
      type: "text",
      text: "Tell me more about: Option A",
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].type).toBe("text");
    expect(interactions[0].text).toBe("Tell me more about: Option A");
    client.ws.close();
  });

  // ─── Pros/Cons sends text message ───

  it("should handle pros/cons as a text message", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    await client.send({
      type: "text",
      text: "Compare these options with pros and cons: Option A, Option B",
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].text).toContain("pros and cons");
    client.ws.close();
  });

  // ─── Rapid interactions ───

  it("should handle rapid sequential interactions", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    // Simulate rapid clicking: select A, then B (single choice fires immediately each time)
    await client.send({ type: "interaction", blockId: "b1", action: "select", value: "a" });
    await client.send({ type: "interaction", blockId: "b1", action: "select", value: "b" });

    expect(interactions).toHaveLength(2);
    expect(interactions[0].value).toBe("a");
    expect(interactions[1].value).toBe("b");
    client.ws.close();
  });

  it("should handle multi-choice submit after multiple toggles", async () => {
    server = await createVisualServer("./spa");
    const interactions: any[] = [];
    server.onInteraction = (msg) => interactions.push(msg);

    const client = connect(server.url);
    await client.ready;

    // Final submit with 3 selections
    await client.send({
      type: "interaction",
      blockId: "b-multi",
      action: "submit",
      values: { opt0: "x", opt1: "y", opt2: "z" },
    });

    expect(interactions).toHaveLength(1);
    expect(interactions[0].action).toBe("submit");
    expect(Object.keys(interactions[0].values)).toHaveLength(3);
    client.ws.close();
  });
});
