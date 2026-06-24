#!/usr/bin/env node
// Copies the bundled `uniswap-tx-builder` agent skill into a Claude skills
// directory. Personal scope (~/.claude/skills) by default; pass --project to
// install into ./.claude/skills instead. Uses only Node builtins, so it runs
// from npx without a build step.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "uniswap-tx-builder";
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "skills", SKILL);

if (!existsSync(source)) {
  console.error(`[install-skill] skill source not found at ${source}`);
  process.exit(1);
}

const project = process.argv.includes("--project");
const base = project
  ? join(process.cwd(), ".claude", "skills")
  : join(homedir(), ".claude", "skills");
const dest = join(base, SKILL);

mkdirSync(base, { recursive: true });
cpSync(source, dest, { recursive: true });

console.log(`[install-skill] installed "${SKILL}" → ${dest}`);
console.log(
  project
    ? "[install-skill] scope: this project (.claude/skills) — commit it to share with the repo."
    : "[install-skill] scope: personal (~/.claude/skills) — available in every project.",
);
