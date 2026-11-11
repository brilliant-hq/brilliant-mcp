// env.js: hermetic test scaffolding: a throwaway state dir per test file and a
// URL-opener stub so nothing touches ~/.config/brilliant or pops a browser.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point the state dir at a fresh temp dir and disable the desktop probe (so a
 *  real Brilliant desktop app on the dev box can't leak into a test). Returns a
 *  cleanup fn. Call at file scope BEFORE constructing helpers. */
export function hermeticEnv() {
  const dir = mkdtempSync(join(tmpdir(), "brilliant-mcp-"));
  process.env.BRILLIANT_MCP_STATE_DIR = dir;
  process.env.BRILLIANT_MCP_DISABLE_DESKTOP = "1";
  process.env.BRILLIANT_MCP_QUIET = "1";
  return () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
}

/** A URL opener that records what it was asked to open. */
export function recordingOpener() {
  const opened = [];
  return { opened, openUrl: (url) => opened.push(url) };
}

/** Small fast-timeout leader config for tests. */
export const FAST = {
  wsPorts: [0],
  helloTimeoutMs: 1000,
  approvalTimeoutMs: 1000,
  handoffTimeoutMs: 800,
  callTimeoutMs: 3000,
  fragmentTokenTtlMs: 5000,
};
