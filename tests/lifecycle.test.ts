import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// Mock the server module so we don't start real HTTP servers
const mockServerInstance = {
  port: 99999,
  url: "http://localhost:99999",
  close: vi.fn(),
  pushBlocks: vi.fn(),
  updateBlock: vi.fn(),
  clearBlocks: vi.fn(),
  pushUserChat: vi.fn(),
  pushAssistantText: vi.fn(),
  pushThinkingStart: vi.fn(),
  pushThinkingEnd: vi.fn(),
  pushWorkingStart: vi.fn(),
  pushWorkingEnd: vi.fn(),
  pushTerminalChat: vi.fn(),
  pushToolCallStart: vi.fn(),
  pushToolCallEnd: vi.fn(),
  pushCommands: vi.fn(),
  pushStatus: vi.fn(),
  onInteraction: null as ((msg: unknown) => void) | null,
  onConnect: null as (() => void) | null,
  flushPending: vi.fn(),
};

vi.mock("../src/server.js", () => ({
  createVisualServer: vi.fn(() => Promise.resolve(mockServerInstance)),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Captures registered event handlers by event name */
function createMockPi() {
  const eventHandlers = new Map<string, (...args: any[]) => void | Promise<void>>();
  const activeTools: string[] = ["bash", "read", "edit", "write", "visual"]; // pi auto-activates all extension tools
  const registeredTools: any[] = [];
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | null = null;

  return {
    eventHandlers,
    activeTools,
    registeredTools,

    registerTool: vi.fn((tool: any) => {
      registeredTools.push(tool);
    }),

    registerCommand: vi.fn((name: string, def: any) => {
      commandHandler = def.handler;
    }),

    getCommandHandler() {
      return commandHandler;
    },

    getActiveTools: vi.fn(() => [...activeTools]),

    setActiveTools: vi.fn((tools: string[]) => {
      activeTools.length = 0;
      activeTools.push(...tools);
    }),

    on: vi.fn((event: string, handler: (...args: any[]) => void | Promise<void>) => {
      eventHandlers.set(event, handler);
    }),

    exec: vi.fn(),

    sendUserMessage: vi.fn(() => Promise.resolve()),

    getCommands: vi.fn(() => []),
  };
}

function createMockCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/test/project",
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: vi.fn(() => "abcd1234efgh"),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn(() => Promise.resolve(false)),
    },
    ...overrides,
  };
}

/** Emit a pi event to all registered handlers for that event */
async function emit(pi: ReturnType<typeof createMockPi>, event: string, ...args: any[]) {
  const handler = pi.eventHandlers.get(event);
  if (handler) {
    await handler(...args);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("extension lifecycle", () => {
  let pi: ReturnType<typeof createMockPi>;
  let extensionModule: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset mock server state
    mockServerInstance.close.mockReset();
    mockServerInstance.flushPending.mockReset();
    mockServerInstance.onInteraction = null;
    mockServerInstance.onConnect = null;

    pi = createMockPi();

    // Import the extension (default export is the setup function)
    extensionModule = await import("../src/index.js");
    extensionModule.default(pi);
  });

  describe("registration", () => {
    it("should register the visual tool", () => {
      expect(pi.registerTool).toHaveBeenCalledOnce();
      const tool = pi.registeredTools[0];
      expect(tool.name).toBe("visual");
      expect(tool.label).toBe("Visual");
    });

    it("should register the /visual command", () => {
      expect(pi.registerCommand).toHaveBeenCalledOnce();
      expect(pi.registerCommand).toHaveBeenCalledWith("visual", expect.objectContaining({
        description: expect.stringContaining("Toggle visual mode"),
      }));
    });

    it("should register a session_start handler", () => {
      expect(pi.eventHandlers.has("session_start")).toBe(true);
    });
  });

  describe("session_start — tool deactivation", () => {
    it("should remove 'visual' from active tools on session_start", async () => {
      // Simulate: pi auto-activated all extension tools (including visual)
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read", "edit", "write", "visual");

      await emit(pi, "session_start", { type: "session_start", reason: "startup" });

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.arrayContaining(["bash", "read", "edit", "write"]),
      );
      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.not.arrayContaining(["visual"]),
      );
    });

    it("should deactivate visual on reload", async () => {
      // After reload, pi re-activates all extension tools
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read", "edit", "write", "visual");

      await emit(pi, "session_start", { type: "session_start", reason: "reload" });

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.not.arrayContaining(["visual"]),
      );
    });

    it("should be safe to call session_start when visual is not in active tools", async () => {
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read");

      // Should not throw
      await emit(pi, "session_start", { type: "session_start", reason: "startup" });

      expect(pi.setActiveTools).toHaveBeenCalledWith(["bash", "read"]);
    });
  });

  describe("/visual on — activation", () => {
    it("should add 'visual' to active tools", async () => {
      // First, deactivate (simulating session_start)
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read");
      await emit(pi, "session_start", { type: "session_start", reason: "startup" });

      // Now run /visual on
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.arrayContaining(["visual", "bash", "read"]),
      );
    });

    it("should start the visual server", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      const { createVisualServer } = await import("../src/server.js");
      expect(createVisualServer).toHaveBeenCalledOnce();
    });

    it("should set up server interaction handlers", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      expect(mockServerInstance.onConnect).not.toBeNull();
      expect(mockServerInstance.onInteraction).not.toBeNull();
    });

    it("should call flushPending after setting handlers", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      expect(mockServerInstance.flushPending).toHaveBeenCalledOnce();
    });

    it("should open the browser", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      expect(pi.exec).toHaveBeenCalledOnce();
      // Second arg should be the URL
      expect(pi.exec).toHaveBeenCalledWith(expect.any(String), [mockServerInstance.url]);
    });

    it("should not restart if already active", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // Start once
      await handler("on", ctx);
      vi.clearAllMocks();

      // Try to start again
      await handler("on", ctx);

      // Should notify "already active" instead of starting again
      expect(ctx.ui.notify).toHaveBeenCalledWith("Visual mode is already active", "info");
      const { createVisualServer } = await import("../src/server.js");
      expect(createVisualServer).not.toHaveBeenCalled();
    });
  });

  describe("/visual off — deactivation", () => {
    it("should remove 'visual' from active tools", async () => {
      // Start first
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      // Now stop
      await handler("off", ctx);

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.not.arrayContaining(["visual"]),
      );
    });

    it("should close the server", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      await handler("off", ctx);

      expect(mockServerInstance.close).toHaveBeenCalledOnce();
    });

    it("should notify when not active", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // Don't start, just try to stop
      await handler("off", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Visual mode is not active", "info");
    });
  });

  describe("/visual toggle", () => {
    it("should start visual when inactive (no subcommand)", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // No subcommand — toggle from inactive
      await handler("", ctx);

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.arrayContaining(["visual"]),
      );
    });

    it("should stop visual when active (no subcommand)", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // Start first
      await handler("on", ctx);
      vi.clearAllMocks();

      // Toggle off
      await handler("", ctx);

      expect(pi.setActiveTools).toHaveBeenCalledWith(
        expect.not.arrayContaining(["visual"]),
      );
    });
  });

  describe("/visual status", () => {
    it("should report inactive when not started", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      await handler("status", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Visual mode: inactive", "info");
    });

    it("should report active with URL when started", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      await handler("status", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("active"),
        "info",
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("localhost"),
        "info",
      );
    });
  });

  describe("session_shutdown — cleanup", () => {
    it("should close server and deactivate if active", async () => {
      // Start visual first
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();
      await handler("on", ctx);

      // Simulate session shutdown
      await emit(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" });

      expect(mockServerInstance.close).toHaveBeenCalled();
    });

    it("should be safe when not active", async () => {
      // Don't start visual, just shutdown
      await emit(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" });

      // Should not throw, and server.close should not be called since server is null
      expect(mockServerInstance.close).not.toHaveBeenCalled();
    });
  });

  describe("full lifecycle: session_start → activate → deactivate → session_start", () => {
    it("should correctly handle activate-deactivate-reactivate cycle", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // 1. session_start deactivates visual (even though pi auto-activated it)
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read", "visual");
      await emit(pi, "session_start", { type: "session_start", reason: "startup" });
      expect(pi.activeTools).not.toContain("visual");

      // 2. User starts /visual
      await handler("on", ctx);
      expect(pi.activeTools).toContain("visual");

      // 3. User stops /visual
      await handler("off", ctx);
      expect(pi.activeTools).not.toContain("visual");

      // 4. Reload: session_start again — should still not have visual
      pi.activeTools.push("visual"); // simulates pi re-activating all extension tools
      await emit(pi, "session_start", { type: "session_start", reason: "reload" });
      expect(pi.activeTools).not.toContain("visual");
    });

    it("should survive a reload while visual is active", async () => {
      const ctx = createMockCtx();
      const handler = pi.getCommandHandler();

      // 1. Start visual
      await handler("on", ctx);
      expect(pi.activeTools).toContain("visual");

      // 2. Reload triggers session_shutdown first (cleans up active server)
      await emit(pi, "session_shutdown", { type: "session_shutdown", reason: "reload" });
      expect(mockServerInstance.close).toHaveBeenCalled();

      // 3. Then session_start fires with fresh extension load
      pi.activeTools.length = 0;
      pi.activeTools.push("bash", "read", "visual"); // pi re-activates all extension tools
      await emit(pi, "session_start", { type: "session_start", reason: "reload" });
      expect(pi.activeTools).not.toContain("visual");
    });
  });

  describe("event handlers should no-op when inactive", () => {
    it("should ignore input events when inactive", async () => {
      await emit(pi, "input", { text: "hello", source: "interactive" });

      // Server pushTerminalChat should not be called (server is null)
      expect(mockServerInstance.pushTerminalChat).not.toHaveBeenCalled();
    });

    it("should ignore turn_start when inactive", async () => {
      await emit(pi, "turn_start", {});

      expect(mockServerInstance.pushThinkingEnd).not.toHaveBeenCalled();
      expect(mockServerInstance.pushWorkingStart).not.toHaveBeenCalled();
    });

    it("should ignore tool_execution_start when inactive", async () => {
      await emit(pi, "tool_execution_start", { toolName: "bash", toolCallId: "tc-1", args: {} });

      expect(mockServerInstance.pushToolCallStart).not.toHaveBeenCalled();
    });

    it("should ignore turn_end when inactive", async () => {
      await emit(pi, "turn_end", {
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      });

      expect(mockServerInstance.pushAssistantText).not.toHaveBeenCalled();
    });
  });
});
