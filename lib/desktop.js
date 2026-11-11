// desktop.js: the desktop-app surface. The Brilliant desktop app runs a
// loopback streamable-HTTP MCP server on the published pool 3333/3334/3335.
// We PROBE that pool (loopback only: never a private
// range) with a real MCP `initialize` and confirm the reply's
// serverInfo.name === "brilliant". If found, desktop is a surface like a tab and
// MCP is relayed to it verbatim by POSTing the JSON-RPC payload to /mcp.
//
// Spec friction (reported, not silently rerouted): the brief said "GET /mcp
// handshake". A bare GET on the desktop's streamable-HTTP transport does not
// return an identity: it hands off to the SSE stream. Identity lives in the MCP
// `initialize` reply's serverInfo, so detection uses an `initialize` POST (the
// actual MCP handshake). Still 127.0.0.1-only, still a handshake.

import http from "node:http";
import { LOOPBACK } from "./util.js";

/** The published desktop MCP pool (loopback). Never scanned beyond these three. */
export const DESKTOP_PORTS = [3333, 3334, 3335];

/** The pool the probe actually walks. BRILLIANT_MCP_DESKTOP_PORTS (comma list)
 *  overrides it for validation rigs: a real app under BRILLIANT_HOME isolation
 *  deliberately binds an ephemeral port (published in its config dir's
 *  `mcp_endpoint` file) so it can never occupy a live session's pool slot, and
 *  a validator names that port here instead of touching a real session's 3333.
 *  Probes stay loopback-only regardless (postMcp dials LOOPBACK). */
export function desktopPorts() {
  const env = process.env.BRILLIANT_MCP_DESKTOP_PORTS;
  if (!env) return DESKTOP_PORTS;
  const ports = env
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
  return ports.length ? ports : DESKTOP_PORTS;
}

const DESKTOP_TIMEOUT_MS = 1500;

/** One loopback POST to /mcp with a JSON body; resolves the response text (or
 *  rejects). Sends a loopback Host and NO Origin so the desktop's own
 *  DNS-rebinding guard treats it as a non-browser client and admits it. */
export function postMcp(port, jsonRpcString, { timeoutMs = DESKTOP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(jsonRpcString, "utf8");
    const req = http.request(
      {
        host: LOOPBACK,
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Streamable-HTTP clients advertise both; the desktop server replies
          // application/json for a plain request.
          accept: "application/json, text/event-stream",
          "content-length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, text });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("desktop probe timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Parse a streamable-HTTP reply body, which may be raw JSON or an SSE frame
 *  (`event: message\ndata: {...}`). Returns the parsed JSON object or null. */
export function parseMaybeSse(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // SSE: pick the last `data:` line.
  let data = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) data = m[1];
  }
  if (data == null) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Probe one port: an MCP `initialize`; true only if serverInfo.name is
 *  "brilliant". */
export async function detectDesktopOnPort(port) {
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: "brilliant-mcp-detect",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "@brilliant-hq/mcp", version: "detect" },
    },
  });
  let res;
  try {
    res = await postMcp(port, init);
  } catch {
    return false;
  }
  if (!res || res.status >= 400) return false;
  const parsed = parseMaybeSse(res.text);
  const name = parsed && parsed.result && parsed.result.serverInfo && parsed.result.serverInfo.name;
  return name === "brilliant";
}

/** Probe the whole pool; returns the first port hosting the Brilliant desktop
 *  app, or null. Loopback only. */
export async function detectDesktop(ports = desktopPorts()) {
  for (const port of ports) {
    if (await detectDesktopOnPort(port)) return port;
  }
  return null;
}
