// shared_tab_id_surfaces.test.js: two tabs that present the SAME tabId (a
// viewer that mints the id once per profile, a duplicated tab, or a reload
// whose new socket lands before the old one closes) must not drop each other.
// The field shape: tab 2 connects under tab 1's id, tab 1
// closes, and the next tools/call finds no surface and opens a Playground
// handoff. A close may only remove the surface its own socket registered.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");
const { forwardToLeader } = await import("../lib/follower.js");

let leader;
const opener = recordingOpener();
before(async () => {
  leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
  state.addAssociation("assoc-secret-xyz");
});
after(async () => {
  await leader.close();
  cleanup();
});

test("closing the first of two same-id tabs leaves the second answering tools/call, no handoff", async () => {
  const first = await connectStubTab({ port: leader.wsPort, association: "assoc-secret-xyz", tabId: "tab-profile" });
  assert.equal(first.outcome, "accepted");
  first.sendSurface();
  const second = await connectStubTab({ port: leader.wsPort, association: "assoc-secret-xyz", tabId: "tab-profile" });
  assert.equal(second.outcome, "accepted");
  second.sendSurface();

  const closed = first.waitClose();
  first.close();
  await closed;
  await new Promise((r) => setTimeout(r, 50)); // let the leader see the close

  try {
    const info = { rpcPort: leader.rpcPort, token: leader.token };
    const call = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_html", arguments: { t: 2 } } });
    const reply = JSON.parse(await forwardToLeader(info, call, "session-two-tabs"));
    assert.equal(reply.result && reply.result.content[0].text, 'echo:{"t":2}', "the still-open tab answered");
    assert.deepEqual(opener.opened, [], "no Playground handoff opened");
  } finally {
    second.close(); // an unregistered socket would otherwise hold the runner open
  }
});
