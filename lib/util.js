// util.js: the small shared primitives: stderr logging (stdout is reserved for
// JSON-RPC frames and must never carry a stray byte), token/id minting, a few
// JSON-RPC helpers, and the platform URL opener.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** Log to STDERR only. stdout is the stdio MCP transport: one stray line there
 *  corrupts the client's parse, so nothing but JSON-RPC frames may reach it. */
export function log(...args) {
  if (process.env.BRILLIANT_MCP_QUIET === "1") return;
  process.stderr.write("[brilliant-mcp] " + args.map(String).join(" ") + "\n");
}

/** A cryptographically-random hex token (default 32 bytes -> 64 hex chars).
 *  Used for the follower->leader /rpc auth token and the fragment handoff token. */
export function mintToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** A short random session id, one per helper process (== one agent session). */
export function newSessionId() {
  return crypto.randomBytes(9).toString("base64url");
}

/** This helper's OWN version, the bytes THIS process is running. Read from the
 *  package.json we were loaded from (so a stale npx-cached leader reports the
 *  version it actually holds, not a guess), overridable by BRILLIANT_MCP_VERSION
 *  for tests + drills. It is stamped into leader.json so peers can tell whose
 *  bytes are fresher and force a handoff toward the newest. */
export function ownVersion() {
  const env = process.env.BRILLIANT_MCP_VERSION;
  if (typeof env === "string" && env.length > 0) return env;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Compare two dotted version strings numerically, part by part; a trailing
 *  pre-release suffix ("-beta.1") on a part is dropped before the numeric read.
 *  Returns -1 if a < b, 1 if a > b, 0 if equal. A non-string is treated as the
 *  oldest possible version (an unstamped lease predates the durability fix and
 *  must lose to any stamped peer). */
export function compareVersions(a, b) {
  const parse = (v) =>
    (typeof v === "string" ? v : "")
      .split(".")
      .map((p) => parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const av = typeof a === "string" ? parse(a) : [-1];
  const bv = typeof b === "string" ? parse(b) : [-1];
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Parse a JSON-RPC message string. Returns { ok, msg } or { ok:false, error }. */
export function parseMessage(str) {
  try {
    const decoded = JSON.parse(str);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { ok: false, error: "expected a JSON object" };
    }
    return { ok: true, msg: decoded };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** A JSON-RPC message with no id (notification) or no method (response) gets no
 *  reply: the stdio transport writes nothing, the HTTP transport answers 202. */
export function isNoReply(msg) {
  return typeof msg.method !== "string" || msg.id === undefined || msg.id === null;
}

export function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** True when a JSON-RPC reply STRING carries a `result` (vs an `error`). */
export function replyIsResult(reply) {
  if (!reply) return false;
  try {
    const parsed = JSON.parse(reply);
    return parsed && Object.prototype.hasOwnProperty.call(parsed, "result");
  } catch {
    return false;
  }
}

/** Open a URL in the user's default browser using the platform opener.
 *  Injectable for tests via BRILLIANT_MCP_OPENER (a command that receives the
 *  URL as its final argument, e.g. a recording shell script). Never blocks. */
export function openUrl(url) {
  const override = process.env.BRILLIANT_MCP_OPENER;
  let cmd, args, useShell = false;
  if (override) {
    cmd = override;
    args = [url];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd builtin; the empty "" is the (ignored) window title so a
    // URL with spaces/quotes is not mistaken for it.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: useShell });
    child.on("error", (e) => log("openUrl failed:", e.message));
    child.unref();
    return true;
  } catch (e) {
    log("openUrl threw:", e.message);
    return false;
  }
}

/** Loopback host check (anti-DNS-rebinding). Accepts a raw Host header value
 *  (may carry a :port). 127.0.0.1, ::1, and the literal `localhost` only. */
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  let host = hostHeader.trim();
  // Strip an [ipv6]:port or host:port suffix.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(1, end) : host;
  } else if (host.includes(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  host = host.toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** The exact web origin the tab must present. Unforgeable from a web page. */
export const BRILLIANT_ORIGIN = "https://brilliant.design";

/** The loopback literal every listener binds. Never 0.0.0.0, never a hostname. */
export const LOOPBACK = "127.0.0.1";
