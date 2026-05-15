import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pi-tui Text
vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    content: string;
    constructor(c: string) { this.content = c; }
  },
}));

// Mock typebox
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn((shape) => shape),
    Array: vi.fn((item, opts) => ({ ...item, ...opts })),
    Any: vi.fn((opts) => opts),
    Optional: vi.fn((schema) => schema),
    String: vi.fn((opts) => opts),
  },
  Static: undefined,
}));

// Mock pi-ai StringEnum
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: vi.fn((values) => values),
}));

describe("visual tool", () => {
  let createVisualTool: any;
  let mockState: any;
  let mockPushBlocks: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/tool.js");
    createVisualTool = mod.createVisualTool;

    mockPushBlocks = vi.fn();
    mockState = {
      active: true,
      server: {
        port: 12345,
        url: "http://localhost:12345",
        pushBlocks: mockPushBlocks,
        updateBlock: vi.fn(),
        clearBlocks: vi.fn(),
        onInteraction: null,
      },
      blocksRendered: 0,
    };
  });

  function getTool() {
    return createVisualTool(() => mockState);
  }

  it("should throw if visual mode is not active", async () => {
    mockState.active = false;
    const tool = getTool();

    await expect(
      tool.execute("tc-1", { blocks: [{ type: "explanation", content: { title: "hi" } }] }, undefined, undefined, undefined),
    ).rejects.toThrow("Visual mode is not active");
  });

  it("should throw if server is null", async () => {
    mockState.server = null;
    const tool = getTool();

    await expect(
      tool.execute("tc-1", { blocks: [{ type: "explanation", content: { title: "hi" } }] }, undefined, undefined, undefined),
    ).rejects.toThrow("Visual mode is not active");
  });

  it("should push blocks and return a result", async () => {
    const tool = getTool();

    const result = await tool.execute(
      "tc-1",
      { blocks: [{ type: "explanation", content: { title: "Hello", body: "World" } }] },
      undefined,
      undefined,
      undefined,
    );

    expect(mockPushBlocks).toHaveBeenCalledOnce();
    const [messageId, blocks] = mockPushBlocks.mock.calls[0];
    expect(messageId).toMatch(/^msg-\d+$/);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("explanation");
    expect(blocks[0].content).toEqual({ title: "Hello", body: "World" });
    expect(blocks[0].id).toMatch(/^block-\d+-\d+$/);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Rendered 1 block(s)");
    expect(result.terminate).toBe(true);
    expect(result.details.blockCount).toBe(1);
    expect(result.details.blockTypes).toEqual(["explanation"]);
  });

  it("should use custom message when provided", async () => {
    const tool = getTool();

    const result = await tool.execute(
      "tc-1",
      {
        blocks: [{ type: "code", content: { code: "const x = 1;", language: "ts" } }],
        message: "Here's the code",
      },
      undefined,
      undefined,
      undefined,
    );

    expect(result.content[0].text).toBe("Here's the code");
  });

  it("should handle multiple blocks", async () => {
    const tool = getTool();

    const result = await tool.execute(
      "tc-1",
      {
        blocks: [
          { type: "explanation", content: { title: "Part 1" } },
          { type: "code", content: { code: "hello" } },
          { type: "table", content: { headers: ["a"], rows: [["b"]] } },
        ],
      },
      undefined,
      undefined,
      undefined,
    );

    expect(mockPushBlocks).toHaveBeenCalledOnce();
    const [, blocks] = mockPushBlocks.mock.calls[0];
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b: any) => b.type)).toEqual(["explanation", "code", "table"]);

    // All IDs should be unique
    const ids = blocks.map((b: any) => b.id);
    expect(new Set(ids).size).toBe(3);

    expect(result.details.blockCount).toBe(3);
  });

  it("should increment blocksRendered counter", async () => {
    const tool = getTool();

    await tool.execute(
      "tc-1",
      { blocks: [{ type: "list", content: { items: [] } }] },
      undefined,
      undefined,
      undefined,
    );

    expect(mockState.blocksRendered).toBe(1);

    await tool.execute(
      "tc-2",
      { blocks: [{ type: "list", content: { items: [] } }, { type: "tree", content: { items: [] } }] },
      undefined,
      undefined,
      undefined,
    );

    expect(mockState.blocksRendered).toBe(3);
  });

  it("should preserve style property on blocks", async () => {
    const tool = getTool();

    await tool.execute(
      "tc-1",
      { blocks: [{ type: "explanation", content: { title: "Styled" }, style: "border-blue-500" }] },
      undefined,
      undefined,
      undefined,
    );

    const [, blocks] = mockPushBlocks.mock.calls[0];
    expect(blocks[0].style).toBe("border-blue-500");
  });

  it("should not include style when not provided", async () => {
    const tool = getTool();

    await tool.execute(
      "tc-1",
      { blocks: [{ type: "explanation", content: { title: "No style" } }] },
      undefined,
      undefined,
      undefined,
    );

    const [, blocks] = mockPushBlocks.mock.calls[0];
    expect(blocks[0].style).toBeUndefined();
  });

  it("should have correct tool metadata", () => {
    const tool = getTool();

    expect(tool.name).toBe("visual");
    expect(tool.label).toBe("Visual");
    expect(tool.description).toContain("visual blocks");
    expect(tool.promptSnippet).toBeDefined();
    expect(tool.promptGuidelines).toBeInstanceOf(Array);
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
  });

  it("should have renderCall that returns a Text element", () => {
    const tool = getTool();

    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = tool.renderCall(
      { blocks: [{ type: "chart" }, { type: "table" }] },
      mockTheme,
    );

    expect(result).toBeDefined();
    expect(result.content).toContain("visual");
    expect(result.content).toContain("2 block(s)");
  });

  it("should have renderResult that returns a Text element", () => {
    const tool = getTool();

    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    };

    const result = tool.renderResult(
      { content: [{ type: "text", text: "Rendered 5 block(s)" }] },
      {},
      mockTheme,
    );

    expect(result).toBeDefined();
    expect(result.content).toContain("✓");
    expect(result.content).toContain("Rendered");
  });
});
