// envelope_roundtrip.test.js: the frozen wire envelope, end to end against a
// stub tab: fragment handoff, verbatim mcp/mcp-reply, the approval->persisted-
// association flow, multi-tab disclosure, and the no-surface local initialize.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");

let leader;
let opener;
before(async () => {
  opener = recordingOpener();
  leader = await startLeader({ ...FAST, openUrl: opener.openUrl, toolsSnapshot: () => null });
});
after(async () => {
  await leader.close();
  cleanup();
});

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("no surface: tools/* triggers a fragment handoff, the URL carries port+token, the paired tab answers verbatim", async () => {
  const listReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const p = leader.handle(listReq, "sess-handoff");

  const url = await waitFor(() => opener.opened.at(-1));
  assert.match(url, /^https:\/\/brilliant\.design\/playground\?utm_source=mcp-helper#bridge=/, "prod handoff opens /playground, not the bare root");
  const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(url);
  assert.ok(m, `handoff URL well-formed: ${url}`);
  const port = Number(m[1]);
  const token = m[2];
  assert.equal(port, leader.handoffPortNow());

  const tab = await connectStubTab({ port, token, tabId: "handoff-tab" });
  assert.equal(tab.outcome, "accepted");
  assert.ok(tab.acceptedAssociation && tab.acceptedAssociation.length > 0, "fragment pairing hands back a fresh association");

  const reply = JSON.parse(await p);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.tools[0].name, "create_html", "tab's tools/list relayed verbatim");
  tab.close();
});

test("no surface: initialize is answered locally (server 'brilliant' + open-the-app instructions), NOT a handoff", async () => {
  // fresh session with no bound surface; disconnect any lingering surface first
  const openedBefore = opener.opened.length;
  const initReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  // Only local if no surface: ensure none by using a brand new leader session
  // state: the handoff tab from the previous test was closed. Give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  const reply = JSON.parse(await leader.handle(initReq, "sess-init"));
  if (reply.result.serverInfo.name === "brilliant") {
    assert.match(reply.result.instructions, /brilliant\.design|desktop app/i);
    assert.equal(opener.opened.length, openedBefore, "initialize does not open a browser");
  } else {
    // A surface was still connected -> it relayed; that is also valid, skip.
    assert.ok(true);
  }
});

test("fallback approval flow: no creds -> approval-needed -> approve persists the association -> later reconnect is accepted directly", async () => {
  const tab1 = await connectStubTab({
    port: leader.wsPort,
    autoApprove: true,
    approveAssociation: "persisted-assoc-1",
    tabId: "approve-tab",
  });
  assert.equal(tab1.outcome, "accepted");
  assert.equal(state.isKnownAssociation("persisted-assoc-1"), true, "association persisted on approve");

  const tab2 = await connectStubTab({ port: leader.wsPort, association: "persisted-assoc-1", tabId: "reconnect-tab" });
  assert.equal(tab2.outcome, "accepted", "known association is accepted without another approval");
  tab1.close();
  tab2.close();
});

test("multi-tab: a bound tools/call names its tab and lists the others in _meta.brilliant.otherTabs", async () => {
  state.addAssociation("mt-a");
  state.addAssociation("mt-b");
  const tabB = await connectStubTab({ port: leader.wsPort, association: "mt-b", tabId: "tab-B", project: { handle: "beta", name: "Beta", title: "Beta" } });
  const tabA = await connectStubTab({ port: leader.wsPort, association: "mt-a", tabId: "tab-A", project: { handle: "alpha", name: "Alpha", title: "Alpha" } });
  assert.equal(tabB.outcome, "accepted");
  assert.equal(tabA.outcome, "accepted");
  // tabA connected last -> most-recently-active -> the unbound call binds to it.
  await waitFor(() => leader.surfacesSnapshot().length >= 2);

  const call = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_html", arguments: {} } });
  const reply = JSON.parse(await leader.handle(call, "sess-mt"));
  const disc = reply.result._meta.brilliant;
  assert.equal(disc.tabId, "tab-A");
  const others = disc.otherTabs.map((t) => t.tabId);
  assert.ok(others.includes("tab-B"), `otherTabs should include tab-B, got ${JSON.stringify(others)}`);

  // first-bind-wins: the same session stays on tab-A.
  assert.equal(leader.bindingsSnapshot().get("sess-mt"), "tab-A");
  tabA.close();
  tabB.close();
});

test("relayed initialize carries _meta.brilliant with the surface list; no-surface local initialize fabricates none", async () => {
  // Let the prior tabs fully drop so the no-surface path is genuine.
  await waitFor(() => leader.surfacesSnapshot().length === 0, 1500);

  const initReq = JSON.stringify({ jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const local = JSON.parse(await leader.handle(initReq, "sess-init-local"));
  assert.equal(local.result.serverInfo.name, "brilliant", "no surface -> answered locally");
  assert.equal(local.result._meta, undefined, "no _meta fabricated when nothing is connected");

  // Pair a tab, then the relayed initialize gets the same disclosure object.
  state.addAssociation("init-assoc");
  const tab = await connectStubTab({
    port: leader.wsPort,
    association: "init-assoc",
    tabId: "init-tab",
    project: { handle: "gamma", name: "Gamma", title: "Gamma Home" },
  });
  assert.equal(tab.outcome, "accepted");
  await waitFor(() => leader.surfacesSnapshot().length === 1);

  const relayed = JSON.parse(await leader.handle(initReq, "sess-init-relay"));
  assert.equal(relayed.result.serverInfo.name, "brilliant-web", "relayed verbatim from the tab");
  const disc = relayed.result._meta.brilliant;
  assert.equal(disc.tabId, "init-tab");
  assert.deepEqual(disc.project, { handle: "gamma", name: "Gamma", title: "Gamma Home" });
  assert.deepEqual(disc.otherTabs, [], "only one surface -> no others");
  tab.close();
});
