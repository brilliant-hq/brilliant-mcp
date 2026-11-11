// busy_desktop_keeps_its_sessions.test.js: A BUSY DESKTOP IS NOT A DEAD ONE.
//
// The field shape: a user's desktop
// app stalled for minutes; one tools/call outran the 120 s call budget, the
// relay-failure re-probe (a 1.5 s initialize) timed out against the same
// stalled app, the desktop surface flipped connected=false, and the session
// rebound to the one connected web tab: a brilliant.design tab with NO project
// open. From then on `list_projects` answered {"projects":[]} and every
// `project` argument "No project matches", for the rest of the session, while
// the app had recovered and listed 82 projects. Two laws:
//   1. a call that timed out reached a live server (it accepted the request),
//      so it never flips the desktop surface; only a refused connection does.
//   2. a web tab with no project open addresses nothing, so it never outranks
//      a connected desktop app.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { startStubDesktop } from "./helpers/stub_desktop.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");

const stubs = [];
after(async () => {
  for (const s of stubs) await s.close();
  cleanup();
});

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

const EMPTY_PROJECT = { handle: "", name: "", title: "" };
const call = (id) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_projects", arguments: {} } });

test("a desktop call that times out keeps the session on the desktop once the app answers again (law 1)", async () => {
  let busy = false;
  let probeAnswers = true;
  const stub = await startStubDesktop({ serverName: "brilliant", hangToolsCall: () => busy });
  stubs.push(stub);
  const leader = await startLeader({
    ...FAST,
    callTimeoutMs: 400,
    openUrl: recordingOpener().openUrl,
    // The stalled app cannot answer the re-probe either (its isolate is busy).
    detectDesktop: async () => (probeAnswers ? stub.port : null),
  });
  try {
    const r1 = JSON.parse(await leader.handle(call(1), "sess-busy"));
    assert.equal(r1.result._meta.brilliant.surface, "desktop");
    state.addAssociation("tab-empty");
    const tab = await connectStubTab({
      port: leader.wsPort, association: "tab-empty", tabId: "web-empty", project: EMPTY_PROJECT,
    });
    assert.equal(tab.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 2);

    // The stall: the call outruns the budget and the re-probe finds nothing.
    busy = true;
    probeAnswers = false;
    const r2 = JSON.parse(await leader.handle(call(2), "sess-busy"));
    assert.ok(r2.error && /may still have applied/.test(r2.error.message), "the timed-out call says so");

    // The app recovers. The same session's next call reaches the desktop, never
    // the project-less tab.
    busy = false;
    probeAnswers = true;
    const r3 = JSON.parse(await leader.handle(call(3), "sess-busy"));
    assert.ok(r3.result, `call after the stall succeeds: ${JSON.stringify(r3).slice(0, 200)}`);
    assert.equal(r3.result._meta.brilliant.surface, "desktop", "the session stayed on the desktop app");
    tab.close();
  } finally {
    await leader.close();
  }
});

test("a web tab with no project open never outranks a connected desktop (law 2); a tab with a project still does", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  const leader = await startLeader({ ...FAST, openUrl: recordingOpener().openUrl, detectDesktop: async () => stub.port });
  try {
    await leader.handle(call(1), "sess-warm"); // the desktop is registered
    state.addAssociation("tab-empty-2");
    const empty = await connectStubTab({
      port: leader.wsPort, association: "tab-empty-2", tabId: "web-empty-2", project: EMPTY_PROJECT,
    });
    assert.equal(empty.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 2);
    const r1 = JSON.parse(await leader.handle(call(2), "sess-fresh"));
    assert.equal(r1.result._meta.brilliant.surface, "desktop", "a project-less tab does not take a fresh session");

    state.addAssociation("tab-acme");
    const acme = await connectStubTab({ port: leader.wsPort, association: "tab-acme", tabId: "web-acme" });
    assert.equal(acme.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 3);
    const r2 = JSON.parse(await leader.handle(call(3), "sess-fresh-2"));
    assert.equal(r2.result._meta.brilliant.surface, "web", "a tab with a project still outranks the desktop");
    assert.equal(r2.result._meta.brilliant.tabId, "web-acme");
    empty.close();
    acme.close();
  } finally {
    await leader.close();
  }
});
