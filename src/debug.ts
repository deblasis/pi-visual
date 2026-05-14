// src/debug.ts — Gated debug logging for pi-visual extension
// Enable by setting PI_VISUAL_DEBUG=1 (or any truthy value)

const DEBUG = !!process.env.PI_VISUAL_DEBUG;

export const log = DEBUG
  ? (...args: unknown[]) => console.log("[pi-visual]", ...args)
  : () => {};

export const warn = DEBUG
  ? (...args: unknown[]) => console.warn("[pi-visual]", ...args)
  : () => {};

export const error = (...args: unknown[]) => console.error("[pi-visual]", ...args);
