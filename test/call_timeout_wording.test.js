// call_timeout_wording.test.js: when a tab does not answer an mcp frame within
// the call timeout, the surfaced JSON-RPC error must warn that the operation
// MAY HAVE APPLIED and tell the agent to verify with a read tool before
// retrying. Proven live: a slow tab HAD applied the mutation, and an agent that
// retried on the old "did not reply within the call timeout" text double-created.
//
// The envelope (-32000, id) is frozen; the error TEXT is not.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");
const { forwardToLeader } = await import("../lib/follower.js");

let leader;
before(async () => {
  // Short call timeout so the (deliberately unanswered) call rejects fast.
  leader = await startLeader({ ...FAST, callTimeoutMs: 400, openUrl: recordingOpener().openUrl });
  state.addAssociation("assoc-secret-xyz");
});
after(async () => {
  await leader.close();
  cleanup();
});

test("a call the tab never answers surfaces a may-have-applied + verify error", async () => {
  const tab = await connectStubTab({
    port: leader.wsPort,
    association: "assoc-secret-xyz",
    swallowMcp: true, // handshakes, but never replies to the mcp frame
  });
  assert.equal(tab.outcome, "accepted");
  tab.sendSurface();

  const info = { rpcPort: leader.rpcPort, token: leader.token };
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "create_modify_elements", arguments: { canvasId: "C", elements: "r s(10,10)" } },
  });
  const reply = JSON.parse(await forwardToLeader(info, call, "session-timeout"));

  // Envelope intact: same id, JSON-RPC error with the server code.
  assert.equal(reply.id, 11);
  assert.equal(reply.error.code, -32000);

  const msg = reply.error.message;
  // The crux: the mutation may have landed, so retrying blindly double-creates.
  assert.match(msg, /may (still )?have applied/i, `must say the op MAY have applied: ${msg}`);
  assert.match(msg, /verify/i, `must tell the agent to verify: ${msg}`);
  assert.match(msg, /lookup/i, `must name the lookup read tool: ${msg}`);
  assert.match(msg, /get_selection/i, `must name the get_selection read tool: ${msg}`);
  assert.match(msg, /before retrying/i, `must say verify BEFORE retrying: ${msg}`);
  // No em dashes in surfaced wording.
  assert.ok(!msg.includes("-"), `no em dashes: ${msg}`);

  tab.close();
});
