import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test debug.ts with the env variable set/unset
describe("debug module", () => {
  const originalDebug = process.env.PI_VISUAL_DEBUG;

  afterEach(() => {
    if (originalDebug !== undefined) {
      process.env.PI_VISUAL_DEBUG = originalDebug;
    } else {
      delete process.env.PI_VISUAL_DEBUG;
    }
    vi.restoreAllMocks();
  });

  it("should suppress log/warn when PI_VISUAL_DEBUG is not set", async () => {
    delete process.env.PI_VISUAL_DEBUG;
    vi.resetModules();

    const debug = await import("../src/debug.js");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    debug.log("should not appear");
    debug.warn("should not appear either");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should emit log/warn when PI_VISUAL_DEBUG=1", async () => {
    process.env.PI_VISUAL_DEBUG = "1";
    vi.resetModules();

    const debug = await import("../src/debug.js?test=1");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    debug.log("debug message");
    debug.warn("warning message");

    expect(logSpy).toHaveBeenCalledWith("[pi-visual]", "debug message");
    expect(warnSpy).toHaveBeenCalledWith("[pi-visual]", "warning message");
  });

  it("should always emit errors regardless of debug flag", async () => {
    delete process.env.PI_VISUAL_DEBUG;
    vi.resetModules();

    const debug = await import("../src/debug.js?test=2");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug.error("critical error");

    expect(errorSpy).toHaveBeenCalledWith("[pi-visual]", "critical error");
  });
});
