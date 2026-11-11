// e2e.test.js: the whole path exercised for real: a spawned `brilliant-mcp`
// stdio process (the leader) <- JSON-RPC lines on stdin -> reply lines on
// stdout, with a stub tab connected over ws. Proves verbatim JSON-RPC
// pass-through and the helper-attached _meta.brilliant disclosure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const STATE = process.env.BRILLIANT_MCP_STATE_DIR;
const state = await import("../lib/state.js");
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "brilliant-mcp.js");

let child;
const replies = new Map();
let stdoutBuf = "";

function collect(chunk) {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.set(msg.id, msg);
    } catch {
      /* not a JSON-RPC line */
    }
  }
}

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

async function waitFor(pred, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`e2e waitFor timed out: ${label}`);
}

before(async () => {
  child = spawn(process.execPath, [BIN], {
    env: {
      ...process.env,
      BRILLIANT_MCP_STATE_DIR: STATE,
      BRILLIANT_MCP_DISABLE_DESKTOP: "1",
      BRILLIANT_MCP_WS_PORTS: "0",
      BRILLIANT_MCP_QUIET: "1",
      BRILLIANT_MCP_HANDOFF_TIMEOUT_MS: "800",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", collect);
});

after(async () => {
  try {
    child.stdin.end();
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  cleanup();
});

test("spawned stdio helper relays verbatim to a stub tab and attaches _meta.brilliant", async () => {
  // Wait for the child to become leader and publish its ws port.
  const lj = await waitFor(() => {
    const l = state.readLeader();
    return l && l.port ? l : null;
  }, 4000, "leader.json with port");
  assert.equal(lj.pid, child.pid);

  // Pre-approve an association, then connect the stub tab as a surface.
  state.addAssociation("e2e-assoc");
  const tab = await connectStubTab({ port: lj.port, association: "e2e-assoc", tabId: "e2e-tab" });
  assert.equal(tab.outcome, "accepted");
  tab.sendSurface();

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_html", arguments: { hello: "world" } } });

  await waitFor(() => replies.has(1) && replies.has(2) && replies.has(3), 4000, "replies 1,2,3");

  // initialize relayed to the tab (its serverInfo, verbatim).
  assert.equal(replies.get(1).result.serverInfo.name, "brilliant-web");
  // tools/list relayed verbatim.
  assert.equal(replies.get(2).result.tools[0].name, "create_html");
  // tools/call: verbatim content + helper disclosure.
  const call = replies.get(3);
  assert.equal(call.result.content[0].text, 'echo:{"hello":"world"}');
  assert.equal(call.result._meta.brilliant.tabId, "e2e-tab");
  assert.deepEqual(call.result._meta.brilliant.otherTabs, []);

  tab.close();
});
