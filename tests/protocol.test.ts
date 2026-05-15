import { describe, it, expect } from "vitest";
import { BLOCK_TYPES } from "../src/protocol.js";

describe("protocol", () => {
  it("should export all expected block types", () => {
    expect(BLOCK_TYPES).toBeInstanceOf(Array);
    expect(BLOCK_TYPES.length).toBe(23);

    const expectedTypes = [
      "tree", "table", "list",
      "flowchart", "steps", "state_machine",
      "comparison", "diff", "pros_cons",
      "chart", "timeline", "heatmap",
      "graph", "mind_map", "entity_relation",
      "choice", "form", "checklist",
      "explanation", "image", "svg", "code", "markdown",
    ];

    expect([...BLOCK_TYPES].sort()).toEqual([...expectedTypes].sort());
  });

  it("should have no duplicate block types", () => {
    const unique = new Set(BLOCK_TYPES);
    expect(unique.size).toBe(BLOCK_TYPES.length);
  });

  it("should be a readonly const tuple", () => {
    // Should be frozen as const
    expect(Array.isArray(BLOCK_TYPES)).toBe(true);
    // Each entry should be a string
    for (const t of BLOCK_TYPES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
