// desktop_proxy.test.js: the desktop surface. Detection is an MCP `initialize`
// against a loopback /mcp server, accepted only when serverInfo.name is
// "brilliant"; once detected, desktop is a surface and MCP relays to it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { startStubDesktop } from "./helpers/stub_desktop.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const desktop = await import("../lib/desktop.js");
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

test("detects a Brilliant desktop server by serverInfo.name", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  assert.equal(await desktop.detectDesktopOnPort(stub.port), true);
});

test("rejects a non-Brilliant server on the same shape", async () => {
  const stub = await startStubDesktop({ serverName: "some-other-mcp" });
  stubs.push(stub);
  assert.equal(await desktop.detectDesktopOnPort(stub.port), false);
});

test("parses an SSE-wrapped initialize reply", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant", sse: true });
  stubs.push(stub);
  assert.equal(await desktop.detectDesktopOnPort(stub.port), true);
});

test("detectDesktop returns the first matching port in the list", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  const closedPort = 1; // unreachable loopback port to prove it skips + continues
  const found = await desktop.detectDesktop([closedPort, stub.port]);
  assert.equal(found, stub.port);
});

test("leader registers the desktop surface and relays a tools/call to it with disclosure", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  const leader = await startLeader({ ...FAST, openUrl: recordingOpener().openUrl, detectDesktop: async () => stub.port });
  try {
    assert.equal(leader.desktopPort, stub.port);
    assert.ok(leader.surfacesSnapshot().some((s) => s.id === "desktop" && s.kind === "desktop"));

    const call = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "desktop_tool", arguments: { z: 9 } } });
    const reply = JSON.parse(await leader.handle(call, "sess-desktop"));
    assert.equal(reply.result.content[0].text, 'desktop-echo:{"z":9}', "verbatim desktop tool result");
    assert.equal(reply.result._meta.brilliant.tabId, "desktop");
    assert.equal(reply.result._meta.brilliant.surface, "desktop", "desktop disclosed explicitly");
  } finally {
    await leader.close();
  }
});

test("a connected web tab outranks the desktop surface; desktop binds only when no tab, disclosure carries surface + viewOnly", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  const leader = await startLeader({ ...FAST, openUrl: recordingOpener().openUrl, detectDesktop: async () => stub.port });
  try {
    // No tab yet: a tools/call binds the desktop surface.
    const c1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desktop_tool", arguments: {} } });
    const r1 = JSON.parse(await leader.handle(c1, "sess-desk"));
    assert.equal(r1.result._meta.brilliant.surface, "desktop", "desktop bound when no tab is connected");

    // Connect a web tab, then drive the desktop-bound session AGAIN so the
    // desktop becomes the most-recently-active surface. Recency now favors
    // desktop: the ONLY thing that makes the fresh session pick the tab is the
    // tabs-outrank-desktop rule (so this fails under a recency-only selector).
    state.addAssociation("tab-over-desktop");
    const tab = await connectStubTab({ port: leader.wsPort, association: "tab-over-desktop", tabId: "web-1", viewOnly: false });
    assert.equal(tab.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 2);
    await leader.handle(c1, "sess-desk"); // desktop-bound (first-bind-wins) -> desktop is now newest

    const c2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_html", arguments: {} } });
    const r2 = JSON.parse(await leader.handle(c2, "sess-fresh"));
    const disc = r2.result._meta.brilliant;
    assert.equal(disc.surface, "web", "a web tab outranks desktop even when desktop is most-recently-active");
    assert.equal(disc.tabId, "web-1");
    assert.equal(disc.viewOnly, false, "viewOnly disclosed on the target");
    const desktopEntry = disc.otherTabs.find((t) => t.tabId === "desktop");
    assert.ok(desktopEntry, "desktop is still enumerated in otherTabs");
    assert.equal(desktopEntry.surface, "desktop", "otherTabs entry names its surface kind");
    assert.equal(typeof desktopEntry.viewOnly, "boolean", "otherTabs entry carries viewOnly");
    tab.close();
  } finally {
    await leader.close();
  }
});

test("a desktop-bound session unwedges when the app dies: relay failure re-probes, flips the surface, and the next call rebinds to the live tab (field wedge 2026-08-26)", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  let stubGone = false;
  const leader = await startLeader({
    ...FAST,
    openUrl: recordingOpener().openUrl,
    // Mirrors the field shape: the probe finds the app while it runs, nothing
    // after it quits (no other port to move to).
    detectDesktop: async () => (stubGone ? null : stub.port),
  });
  try {
    // Bind the session to desktop (first-bind-wins), then connect a web tab.
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desktop_tool", arguments: {} } });
    const r1 = JSON.parse(await leader.handle(call, "sess-wedge"));
    assert.equal(r1.result._meta.brilliant.surface, "desktop", "bound to desktop while it lives");
    state.addAssociation("tab-unwedge");
    const tab = await connectStubTab({ port: leader.wsPort, association: "tab-unwedge", tabId: "web-alive", viewOnly: false });
    assert.equal(tab.outcome, "accepted");
    await waitFor(() => leader.surfacesSnapshot().length >= 2);

    // The app quits. The bound session's next call fails honestly ONCE...
    stubGone = true;
    await stub.close();
    const r2 = JSON.parse(await leader.handle(call, "sess-wedge"));
    assert.ok(r2.error && /surface relay failed/.test(r2.error.message), "the failing relay itself reports honestly");

    // ...and the failure re-probes: desktop is gone, so the SAME session's next
    // call rebinds to the live web tab instead of erroring forever (pre-fix:
    // "surface relay failed" on every call for the rest of the session).
    const r3 = JSON.parse(await leader.handle(call, "sess-wedge"));
    assert.ok(r3.result, `rebound call succeeds, got: ${JSON.stringify(r3).slice(0, 200)}`);
    assert.equal(r3.result._meta.brilliant.surface, "web", "session rebound to the connected web tab");
    assert.equal(r3.result._meta.brilliant.tabId, "web-alive");
    tab.close();
  } finally {
    await leader.close();
  }
});

test("a desktop app that MOVED ports re-registers on relay failure and the bound session follows it (still desktop, new port)", async () => {
  const stub1 = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub1);
  let currentPort = stub1.port;
  const leader = await startLeader({
    ...FAST,
    openUrl: recordingOpener().openUrl,
    detectDesktop: async () => currentPort,
  });
  try {
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desktop_tool", arguments: {} } });
    const r1 = JSON.parse(await leader.handle(call, "sess-follow"));
    assert.equal(r1.result._meta.brilliant.surface, "desktop");

    // The app restarts on a fresh port: old port dead, probe finds the new one.
    const stub2 = await startStubDesktop({ serverName: "brilliant" });
    stubs.push(stub2);
    currentPort = stub2.port;
    await stub1.close();
    const r2 = JSON.parse(await leader.handle(call, "sess-follow"));
    assert.ok(r2.error && /surface relay failed/.test(r2.error.message), "the failing relay reports honestly");

    const r3 = JSON.parse(await leader.handle(call, "sess-follow"));
    assert.ok(r3.result, `follow-up call succeeds, got: ${JSON.stringify(r3).slice(0, 200)}`);
    assert.equal(r3.result._meta.brilliant.surface, "desktop", "same surface id, re-registered on the new port");
  } finally {
    await leader.close();
  }
});

// ---- the heavy-op relay-timeout family (the duplicate-elements trap) --------
//
// The desktop surface used to relay every tools/call under the DETECTION probe
// budget (1.5s), so a heavy create that SUCCEEDED on the app side but took
// longer than 1.5s surfaced "surface relay failed: desktop probe timeout"
// while the elements were in fact created. An agent that retried on that error
// DUPLICATED. Cross-canvas instancing from a heavy master is the field shape.
// The relay must use the CALL budget (like a web tab) and, when a call really
// does outrun that budget, warn the op MAY HAVE APPLIED (verify before retry),
// never the bare probe-timeout that reads like a transient failure.

test("a heavy desktop op that outruns the 1.5s detection probe still relays cleanly (not a spurious relay failure)", async () => {
  // Replies at 2000ms: past the old hardcoded 1.5s probe timeout, well within
  // the call budget. Pre-fix this surfaced "surface relay failed: desktop probe
  // timeout" (and a retry double-created); post-fix the real result relays.
  const stub = await startStubDesktop({ serverName: "brilliant", toolsCallDelayMs: 2000 });
  stubs.push(stub);
  const leader = await startLeader({
    ...FAST,
    callTimeoutMs: 6000,
    openUrl: recordingOpener().openUrl,
    detectDesktop: async () => stub.port,
  });
  try {
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "create_modify_elements", arguments: { canvasId: "C", elements: "r s(10,10)" } },
    });
    const reply = JSON.parse(await leader.handle(call, "sess-heavy"));
    assert.ok(!reply.error, `heavy op must relay, not fail: ${JSON.stringify(reply).slice(0, 200)}`);
    assert.ok(reply.result, "the desktop result comes back");
    assert.equal(reply.result._meta.brilliant.surface, "desktop");
  } finally {
    await leader.close();
  }
});

test("a LARGE create_html op (the field-reported tool) relays cleanly past the 1.5s detection probe and NEVER surfaces the bare 'desktop probe timeout'", async () => {
  // The field class (2026-08-31, two independent batches): consecutive LARGE
  // create_html calls returned "surface relay failed: desktop probe timeout" to
  // the caller while the create SUCCEEDED app-side (verified by lookup every
  // time). The desktop app converts the HTML to a blueprint and builds the
  // element tree synchronously on its one isolate, so a big payload runs longer
  // than the relay's OLD hardcoded 1.5s DETECTION budget; create_modify_elements
  // and export (smaller / no HTML-conversion step) stayed under it, which is why
  // only create_html wedged. Same seam as the cell above, pinned to the field's
  // exact tool AND error string so a future send() refactor that reinstates the
  // 1.5s budget fails loudly against THIS incident.
  const stub = await startStubDesktop({ serverName: "brilliant", toolsCallDelayMs: 2000 });
  stubs.push(stub);
  const leader = await startLeader({
    ...FAST,
    callTimeoutMs: 6000,
    openUrl: recordingOpener().openUrl,
    detectDesktop: async () => stub.port,
  });
  try {
    // A payload the size a real create_html carries (the field shape), not a
    // toy: the relay is tool-agnostic, so this proves the create_html door.
    const bigHtml = `<div style="display:flex;flex-direction:column">${"<p>row of content</p>".repeat(400)}</div>`;
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "create_html", arguments: { canvasId: "C", html: bigHtml } },
    });
    const reply = JSON.parse(await leader.handle(call, "sess-html"));
    assert.ok(!reply.error, `large create_html must relay, not fail: ${JSON.stringify(reply).slice(0, 200)}`);
    assert.ok(reply.result, "the desktop create_html result comes back");
    assert.equal(reply.result._meta.brilliant.surface, "desktop");
    // The exact field signature, pinned negative: it must never be what the
    // caller sees for a create that in fact applied.
    assert.ok(
      !/desktop probe timeout/.test(JSON.stringify(reply)),
      `must NOT surface the bare probe-timeout: ${JSON.stringify(reply).slice(0, 200)}`,
    );
  } finally {
    await leader.close();
  }
});

test("a desktop op that outruns the CALL budget surfaces a may-have-applied + verify error (not the bare probe timeout)", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant", hangToolsCall: true });
  stubs.push(stub);
  const leader = await startLeader({
    ...FAST,
    callTimeoutMs: 400, // short so the (never-answered) call rejects fast
    openUrl: recordingOpener().openUrl,
    detectDesktop: async () => stub.port,
  });
  try {
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "create_modify_elements", arguments: { canvasId: "C", elements: "r s(10,10)" } },
    });
    const reply = JSON.parse(await leader.handle(call, "sess-hang"));
    assert.equal(reply.error.code, -32000);
    const msg = reply.error.message;
    // The crux: the mutation may have landed on the desktop app, so retrying
    // blindly double-creates. The message must say so and name a read tool.
    assert.match(msg, /may (still )?have applied/i, `must say the op MAY have applied: ${msg}`);
    assert.match(msg, /verify/i, `must tell the agent to verify: ${msg}`);
    assert.match(msg, /lookup/i, `must name the lookup read tool: ${msg}`);
    assert.match(msg, /get_selection/i, `must name the get_selection read tool: ${msg}`);
    assert.match(msg, /before retrying/i, `must say verify BEFORE retrying: ${msg}`);
    assert.ok(!/desktop probe timeout/.test(msg), `must NOT be the bare probe-timeout: ${msg}`);
    const emDash = String.fromCharCode(0x2014);
    assert.ok(!msg.includes(emDash), `no em dashes: ${msg}`);
  } finally {
    await leader.close();
  }
});
