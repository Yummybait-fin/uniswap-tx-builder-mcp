#!/usr/bin/env node
// Publish-time guard: assert the npm tarball contains exactly what we intend
// to ship — nothing missing, nothing extra, no secrets. Runs `npm pack
// --dry-run` (with --ignore-scripts: dist/ must already be built, see the
// `verify:pack` script) and checks the file list against an allowlist.
import { execFileSync } from "node:child_process";

// Every shipped file must live under one of these, …
const ALLOWED_PREFIXES = ["dist/", "bin/", "skills/", ".claude-plugin/"];
// … or be one of these (package.json/README/LICENSE are npm-mandatory).
const ALLOWED_FILES = new Set(["package.json", "README.md", "LICENSE"]);
// These must be present or the package is broken.
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/mcp.js",
  "bin/install-skill.mjs",
  "skills/uniswap-tx-builder/SKILL.md",
  ".claude-plugin/plugin.json",
];
// Nothing matching these may ship, wherever it sits.
const FORBIDDEN = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.npmrc$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519)/i,
  /(^|\/)(secret|credential)s?\./i,
  /\.log$/i,
];

const out = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=error"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const [{ files, size, entryCount }] = JSON.parse(out);
const paths = files.map((f) => f.path);

const errors = [];
for (const p of paths) {
  if (ALLOWED_FILES.has(p)) continue;
  if (!ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    errors.push(`unexpected file outside the allowlist: ${p}`);
  }
}
for (const p of paths) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(p)) errors.push(`forbidden file pattern (${pattern}): ${p}`);
  }
}
for (const required of REQUIRED) {
  if (!paths.includes(required)) errors.push(`required file missing: ${required}`);
}

if (errors.length > 0) {
  console.error("✗ tarball verification FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `✓ tarball OK: ${entryCount} files, ${size} bytes packed — all within ` +
    `[${[...ALLOWED_FILES, ...ALLOWED_PREFIXES].join(", ")}]`,
);
