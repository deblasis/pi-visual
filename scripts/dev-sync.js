#!/usr/bin/env node
// Dev utility: copy local source to the pi-managed extension directory
// so changes take effect on next pi restart (or /refresh)

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PI_VISUAL_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "git",
  "github.com",
  "deblasis",
  "pi-visual",
);

const targets = [
  { src: "src", dest: "src" },
  { src: "spa", dest: "spa" },
];

for (const { src, dest } of targets) {
  const srcPath = join(import.meta.dirname, "..", src);
  const destPath = join(PI_VISUAL_DIR, dest);
  mkdirSync(destPath, { recursive: true });
  cpSync(srcPath, destPath, { recursive: true });
  console.log(`✓ ${src}/ → ${destPath}`);
}

console.log("\nRestart pi or run /refresh to pick up the changes.");
