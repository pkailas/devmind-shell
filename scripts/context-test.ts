// File: scripts/context-test.ts  v1.0
// Verifies DevMind.md / CLAUDE.md / AGENTS.md discovery and precedence.

import { loadProjectContext, formatContextForPrompt } from "../src/util/projectContext.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const log = console.log;

let allOk = true;
const cases: Array<{ name: string; files: Record<string, string>; expectOrder: string[] }> = [
  {
    name: "DevMind.md only",
    files: { "DevMind.md": "# DevMind\nproject conventions" },
    expectOrder: ["DevMind.md"],
  },
  {
    name: "CLAUDE.md only",
    files: { "CLAUDE.md": "# Claude Code\nclaude conventions" },
    expectOrder: ["CLAUDE.md"],
  },
  {
    name: "AGENTS.md only",
    files: { "AGENTS.md": "# AGENTS\ncopilot conventions" },
    expectOrder: ["AGENTS.md"],
  },
  {
    name: "all three: DevMind.md wins, CLAUDE next, AGENTS last",
    files: {
      "AGENTS.md": "agents",
      "CLAUDE.md": "claude",
      "DevMind.md": "devmind",
    },
    expectOrder: ["DevMind.md", "CLAUDE.md", "AGENTS.md"],
  },
  {
    name: "no files",
    files: {},
    expectOrder: [],
  },
];

for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), "devmind-ctx-test-"));
  try {
    for (const [name, content] of Object.entries(c.files)) {
      writeFileSync(join(dir, name), content);
    }
    const loaded = loadProjectContext(dir);
    const actualOrder = loaded.map((f) => f.filename);
    const ok =
      actualOrder.length === c.expectOrder.length &&
      actualOrder.every((n, i) => n === c.expectOrder[i]);
    log(`[${ok ? "PASS" : "FAIL"}] ${c.name}`);
    log(`  expected: [${c.expectOrder.join(", ")}]`);
    log(`  actual:   [${actualOrder.join(", ")}]`);
    if (!ok) allOk = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One additional check: formatContextForPrompt produces empty for no files
const emptyOut = formatContextForPrompt([]);
if (emptyOut !== "") {
  log(`[FAIL] formatContextForPrompt([]) returned non-empty: ${JSON.stringify(emptyOut)}`);
  allOk = false;
} else {
  log(`[PASS] formatContextForPrompt([]) returned empty string`);
}

// And a primary + supplementary block has the expected markers
const blocks = formatContextForPrompt([
  { filename: "DevMind.md", path: "/x", content: "primary content", truncated: false },
  { filename: "CLAUDE.md", path: "/y", content: "supplementary content", truncated: false },
]);
const hasPrimary = blocks.includes("[primary context: DevMind.md]");
const hasSupp = blocks.includes("[supplementary context: CLAUDE.md]");
log(`[${hasPrimary && hasSupp ? "PASS" : "FAIL"}] block markers present`);
log(`  hasPrimary: ${hasPrimary}, hasSupp: ${hasSupp}`);
if (!hasPrimary || !hasSupp) allOk = false;

log(``);
log(`OVERALL: ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
