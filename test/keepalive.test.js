// keepalive.test.js. Both sides speak ping/pong but nobody
// scheduled it, so a silently-dead tab socket lingered as a live surface. The
// leader now pings every keepaliveMs and drops a surface after 2 missed pongs; a
// responsive tab is retained.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");

after(() => cleanup());

async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("a tab that stops answering pings is dropped after 2 missed pongs; a responsive tab stays", async () => {
  const leader = await startLeader({ ...FAST, keepaliveMs: 40, openUrl: () => {} });
  try {
    state.addAssociation("ka-live");
    state.addAssociation("ka-dead");

    const live = await connectStubTab({ port: leader.wsPort, association: "ka-live", tabId: "live-tab" });
    const dead = await connectStubTab({ port: leader.wsPort, association: "ka-dead", tabId: "dead-tab", deaf: true });
    assert.equal(live.outcome, "accepted");
    assert.equal(dead.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 2, 1000);

    // Within a few 40ms cycles the deaf tab crosses 2 missed pongs and is dropped.
    await waitFor(() => !leader.surfacesSnapshot().some((s) => s.id === "dead-tab"), 2000);
    assert.ok(
      leader.surfacesSnapshot().some((s) => s.id === "live-tab"),
      "the responsive tab (which keeps ponging) is retained",
    );
    live.close();
    dead.close();
  } finally {
    await leader.close();
  }
});
