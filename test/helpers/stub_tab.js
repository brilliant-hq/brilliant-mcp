// stub_tab.js: the TAB side of the frozen wire envelope, for tests. A ws
// client that connects, sends hello, answers mcp frames with a tiny MCP
// dispatcher (initialize / tools/list / tools/call / ping), and can be told to
// present a bad Origin/Host/token (refusal tests) or auto-approve on the
// fallback range. It is deliberately NOT the real dispatcher: it just proves
// the helper's verbatim relay + disclosure.

import { WebSocket } from "ws";
import { BRILLIANT_ORIGIN } from "../../lib/util.js";

/** A minimal MCP dispatcher matching the tab dispatcher's shape. Echoes tools/call
 *  args so the helper's verbatim pass-through is assertable; it NEVER sets
 *  _meta.brilliant (that is the helper's job). */
export function defaultDispatch(msg, { serverName = "brilliant-web" } = {}) {
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "test" },
          instructions: "stub tab",
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: [{ name: "create_html", description: "make", inputSchema: { type: "object" } }] },
      };
    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `echo:${JSON.stringify(msg.params && msg.params.arguments)}` }],
          isError: false,
        },
      };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

/**
 * Connect a stub tab. Resolves once the handshake settles (accepted, denied, or
 *: with autoApprove: an approval-needed that we answer).
 *
 * @returns a controller: { outcome, deniedReason, ws, tabId, sendSurface, close,
 *          waitClose }.
 */
export function connectStubTab({
  port,
  token = null,
  association = null,
  tabId = "tab-stub-1",
  project = { handle: "acme", name: "Acme", title: "Acme Home" },
  viewOnly = false,
  origin = BRILLIANT_ORIGIN,
  host, // undefined -> ws sets the real loopback Host
  autoApprove = false,
  approveAssociation = "assoc-secret-xyz",
  dispatch = defaultDispatch,
  serverName = "brilliant-web",
  deaf = false, // when true, never answer a keepalive ping (drop-on-missed-pong test)
  swallowMcp = false, // when true, never answer an mcp frame (call-timeout test)
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: origin };
    if (host) headers.Host = host;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const ctl = {
      outcome: null,
      deniedReason: null,
      approvedWith: null,
      ws,
      tabId,
      sendSurface: (patch = {}) =>
        ws.send(JSON.stringify({ v: 1, kind: "surface", project, active: true, viewOnly, ...patch })),
      close: () => ws.close(),
      waitClose: () => new Promise((r) => ws.on("close", r)),
    };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(ctl);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 1, kind: "hello", role: "tab", token, association, tabId, project, viewOnly }));
    });

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (frame.kind) {
        case "accepted":
          ctl.outcome = "accepted";
          ctl.acceptedAssociation = typeof frame.association === "string" ? frame.association : null;
          return done();
        case "denied":
          ctl.outcome = "denied";
          ctl.deniedReason = frame.reason;
          return done();
        case "approval-needed":
          ctl.outcome = "approval-needed";
          ctl.approvalClient = frame.client;
          if (autoApprove) {
            ctl.approvedWith = approveAssociation;
            ws.send(JSON.stringify({ v: 1, kind: "approve", association: approveAssociation }));
            // wait for the follow-up accepted before resolving
          } else {
            return done();
          }
          return;
        case "mcp": {
          if (swallowMcp) return; // never reply → exercise the leader's call timeout
          const parsed = JSON.parse(frame.payload);
          const reply = dispatch(parsed, { serverName });
          const payload = reply == null ? "" : JSON.stringify(reply);
          ws.send(JSON.stringify({ v: 1, kind: "mcp-reply", id: frame.id, payload }));
          return;
        }
        case "ping":
          if (!deaf) ws.send(JSON.stringify({ v: 1, kind: "pong" }));
          return;
        default:
          return;
      }
    });

    ws.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    ws.on("close", () => {
      // A close before any frame (e.g., server dropped) resolves as a bare close.
      if (!settled) {
        settled = true;
        ctl.outcome = ctl.outcome || "closed";
        resolve(ctl);
      }
    });
  });
}
