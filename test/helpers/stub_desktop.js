// stub_desktop.js: a stand-in for the Brilliant desktop app's streamable-HTTP
// MCP server (127.0.0.1:/mcp). Replies to `initialize` with
// serverInfo.name === "brilliant" (the identity the proxy checks) and echoes
// tools/call. `serverName` can be overridden to prove the proxy REJECTS a
// non-Brilliant server on the same port.
//
// Heavy-op simulation (relay-timeout family): `toolsCallDelayMs` holds a
// tools/call reply for that long before answering (a heavy op that SUCCEEDS but
// is slow); `hangToolsCall` never answers a tools/call (an op that outruns the
// relay budget; pass a function to decide per request, the busy-then-recovered
// app). `initialize` always answers promptly so detection stays fast.

import http from "node:http";

export function startStubDesktop({
  serverName = "brilliant",
  sse = false,
  toolsCallDelayMs = 0,
  hangToolsCall = false,
  port: listenPort = 0,
} = {}) {
  const pendingResponses = new Set(); // hung/delayed res objects, force-closed on shutdown
  const pendingTimers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        return res.end();
      }
      let reply;
      if (msg.method === "initialize") {
        reply = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: "1.0.0" },
          },
        };
      } else if (msg.method === "tools/call") {
        reply = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `desktop-echo:${JSON.stringify(msg.params && msg.params.arguments)}` }] },
        };
      } else if (msg.method === "tools/list") {
        reply = { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "desktop_tool", inputSchema: { type: "object" } }] } };
      } else {
        reply = { jsonrpc: "2.0", id: msg.id, result: {} };
      }
      const text = JSON.stringify(reply);
      const write = () => {
        if (sse) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: message\ndata: ${text}\n\n`);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(text);
        }
      };
      // Heavy-op behaviors apply to tools/call only.
      const hangs = typeof hangToolsCall === "function" ? hangToolsCall() : hangToolsCall;
      if (msg.method === "tools/call" && hangs) {
        pendingResponses.add(res); // answer never comes; force-closed at shutdown
        return;
      }
      if (msg.method === "tools/call" && toolsCallDelayMs > 0) {
        pendingResponses.add(res);
        const t = setTimeout(() => {
          pendingTimers.delete(t);
          pendingResponses.delete(res);
          if (!res.writableEnded) write();
        }, toolsCallDelayMs);
        pendingTimers.add(t);
        return;
      }
      write();
    });
  });
  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const t of pendingTimers) clearTimeout(t);
            pendingTimers.clear();
            for (const res of pendingResponses) {
              try {
                res.destroy();
              } catch {
                /* already gone */
              }
            }
            pendingResponses.clear();
            server.close(() => r());
          }),
      });
    });
  });
}
