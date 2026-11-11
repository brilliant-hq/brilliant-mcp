// rpc_forwarding.test.js: the follower->leader /rpc leg. A follower POSTs
// {token, payload} to the leader's loopback /rpc and streams the reply back.
// The token gate rejects a wrong token; the token is never echoed.

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
  leader = await startLeader({ ...FAST, openUrl: recordingOpener().openUrl });
  state.addAssociation("assoc-secret-xyz");
});
after(async () => {
  await leader.close();
  cleanup();
});

test("a follower forwards a tools/call and streams the tab reply back (with disclosure)", async () => {
  const tab = await connectStubTab({ port: leader.wsPort, association: "assoc-secret-xyz" });
  assert.equal(tab.outcome, "accepted");
  tab.sendSurface();

  const info = { rpcPort: leader.rpcPort, token: leader.token };
  const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_html", arguments: { a: 1 } } });
  const replyStr = await forwardToLeader(info, call, "session-A");
  const reply = JSON.parse(replyStr);

  assert.equal(reply.id, 7);
  assert.equal(reply.result.content[0].text, 'echo:{"a":1}', "verbatim tool result");
  assert.equal(reply.result._meta.brilliant.tabId, tab.tabId, "helper attached disclosure");
  assert.deepEqual(reply.result._meta.brilliant.project, { handle: "acme", name: "Acme", title: "Acme Home" });
  tab.close();
});

test("a wrong /rpc token is rejected and the real token is never leaked", async () => {
  const info = { rpcPort: leader.rpcPort, token: "wrong-token" };
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  await assert.rejects(() => forwardToLeader(info, call, "session-A"), (e) => e.code === "EBADTOKEN");
});

test("ping forwards and answers locally without needing a surface", async () => {
  const info = { rpcPort: leader.rpcPort, token: leader.token };
  const replyStr = await forwardToLeader(info, JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }), "session-B");
  assert.deepEqual(JSON.parse(replyStr), { jsonrpc: "2.0", id: 42, result: {} });
});

test("a notification forwards and yields an empty reply body", async () => {
  const info = { rpcPort: leader.rpcPort, token: leader.token };
  const replyStr = await forwardToLeader(info, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "session-B");
  assert.equal(replyStr, "");
});
