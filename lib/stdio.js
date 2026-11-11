// stdio.js: the newline-delimited JSON-RPC transport (MCP stdio transport
// spec). Each stdin line is one JSON-RPC message with no embedded newlines; we
// dispatch it and write the reply as one stdout line. A notification/response
// yields an empty reply and NO stdout line. Nothing but JSON-RPC frames ever
// reaches stdout: all logging goes to stderr.

import { createHelper } from "./helper.js";
import { log } from "./util.js";

export async function runStdio(opts = {}) {
  const helper = await createHelper(opts);

  // Process lines strictly in order: a stdio client's replies must not
  // interleave, and ordering keeps notifications ahead of the requests that
  // depend on them.
  let queue = Promise.resolve();
  let buffer = "";

  function enqueue(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    queue = queue.then(async () => {
      let reply;
      try {
        reply = await helper.dispatch(trimmed);
      } catch (e) {
        log("dispatch threw:", e.message);
        reply = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e.message) } });
      }
      if (reply && reply.length > 0) process.stdout.write(reply + "\n");
    });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      enqueue(line);
    }
  });

  const shutdown = async (code) => {
    try {
      await queue;
    } catch {
      /* drained */
    }
    try {
      await helper.close();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };

  process.stdin.on("end", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  log(`ready (${helper.role}, session ${helper.sessionId})`);
  return helper;
}
