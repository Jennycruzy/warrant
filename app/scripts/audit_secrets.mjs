#!/usr/bin/env node
// Fails (exit 1) if the frontend source tree contains any browser secret-signing
// path or hardcoded Stellar secret key. Run with: npm run audit:secrets
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src");

// Patterns that must NEVER appear in shipped frontend code.
const FORBIDDEN = [
  { re: /VITE_SOURCE_SECRET/, why: "browser secret-key env var" },
  { re: /\bSOURCE_SECRET\b/, why: "secret-key reference" },
  { re: /Keypair\.fromSecret/, why: "secret-key signing in the browser" },
  { re: /\bsourceSecret\b/, why: "secret-key parameter" },
  { re: /\bS[A-Z2-7]{55}\b/, why: "hardcoded Stellar secret key literal" },
  { re: /0xdeadbeef|FAKE_?HASH|0000000000000000000000000000000000000000000000000000000000000000/i, why: "placeholder/fake transaction hash" },
];

function walk(dir) {
  let files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files = files.concat(walk(p));
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) files.push(p);
  }
  return files;
}

let failures = 0;
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const { re, why } of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        console.error(`✗ ${file}:${i + 1}  ${why}\n    ${line.trim()}`);
        failures++;
      }
    });
  }
}

if (failures > 0) {
  console.error(`\nSecret audit FAILED: ${failures} forbidden pattern(s) in frontend/src.`);
  process.exit(1);
}
console.log("✓ Secret audit passed: no browser secret-key signing or fake hashes in frontend/src.");
