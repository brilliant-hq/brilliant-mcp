// fragment_association.test.js: dead-end re-pair. Fragment
// ports are ephemeral and die with the leader, so a fragment-paired tab would be
// stranded after a helper restart. Per the amended envelope the accepted frame
// hands back a freshly-minted, persisted association; the tab re-pairs over the
// FALLBACK lane after a restart with it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");

after(() => cleanup());

async function waitFor(pred, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("fragment pairing yields a persisted association that re-pairs over the fallback lane after a leader restart", async () => {
  // --- Leader A: pair via the fragment lane, capture the minted association. ---
  const openerA = recordingOpener();
  const leaderA = await startLeader({ ...FAST, openUrl: openerA.openUrl, toolsSnapshot: () => null });
  let assoc;
  try {
    const p = leaderA.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "s1");
    await waitFor(() => openerA.opened.length > 0);
    const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(openerA.opened.at(-1));
    const tab = await connectStubTab({ port: Number(m[1]), token: m[2], tabId: "frag-tab" });
    assert.equal(tab.outcome, "accepted");
    assoc = tab.acceptedAssociation;
    assert.ok(assoc && assoc.length > 0, "the accepted frame carried a fresh association");
    assert.equal(state.isKnownAssociation(assoc), true, "the helper persisted it");
    await p; // drain the relayed tools/list
    tab.close();
  } finally {
    await leaderA.close();
  }

  // --- Leader B (restart, same state dir): re-pair over the FALLBACK lane. ---
  const leaderB = await startLeader({ ...FAST, openUrl: () => {} });
  try {
    const reTab = await connectStubTab({ port: leaderB.wsPort, association: assoc, tabId: "frag-tab" });
    assert.equal(reTab.outcome, "accepted", "the persisted association re-pairs with no fresh approval");
    reTab.close();
  } finally {
    await leaderB.close();
  }
});
