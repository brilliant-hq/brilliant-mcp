#!/usr/bin/env node
// brilliant-mcp: CLI entry. Thin: parse argv, run. All logic lives in lib/.
import { main } from "../lib/cli.js";

main().then(
  (code) => {
    if (typeof code === "number" && code !== 0) process.exit(code);
    // stdio mode never resolves; other commands resolve 0 and fall through.
  },
  (err) => {
    process.stderr.write(`[brilliant-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  },
);
