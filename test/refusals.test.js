// refusals.test.js: the mandatory wire gates: a hello with the wrong Origin,
// a non-loopback Host, or no token on the ephemeral handoff port is denied +
// closed, and each refusal is counted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");

let leader;
const opener = recordingOpener();
before(async () => {
  leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
});
after(async () => {
  await leader.close();
  cleanup();
});

test("wrong Origin is denied and counted", async () => {
  const before = leader.refusals.badOrigin;
  const tab = await connectStubTab({ port: leader.wsPort, origin: "https://evil.example", association: "x" });
  assert.equal(tab.outcome, "denied");
  assert.equal(tab.deniedReason, "bad-origin");
  assert.equal(leader.refusals.badOrigin, before + 1);
});

test("non-loopback Host is denied and counted (anti-DNS-rebinding)", async () => {
  const before = leader.refusals.badHost;
  const tab = await connectStubTab({ port: leader.wsPort, host: "evil.example", association: "x" });
  assert.equal(tab.outcome, "denied");
  assert.equal(tab.deniedReason, "bad-host");
  assert.equal(leader.refusals.badHost, before + 1);
});

test("no valid token on the ephemeral handoff port is denied and counted", async () => {
  // Open a handoff so the ephemeral listener is bound; don't let its wait throw.
  const pending = leader._triggerHandoff().catch(() => {});
  // The handoff listener binds synchronously enough that the URL is recorded.
  await new Promise((r) => setTimeout(r, 50));
  const port = leader.handoffPortNow();
  assert.ok(port, "handoff listener should be bound");
  assert.match(opener.opened.at(-1), /#bridge=\d+&t=[0-9a-f]+/);

  const before = leader.refusals.noToken;
  const tab = await connectStubTab({ port, token: "not-a-real-token" });
  assert.equal(tab.outcome, "denied");
  assert.equal(tab.deniedReason, "bad-token");
  assert.equal(leader.refusals.noToken, before + 1);
  await pending;
});

test("a hello with neither token nor association on the fallback range gets approval-needed (never a silent accept)", async () => {
  const tab = await connectStubTab({ port: leader.wsPort, autoApprove: false });
  assert.equal(tab.outcome, "approval-needed");
  // Names the agent (none relayed here -> generic), NEVER the tab's project.
  assert.notEqual(tab.approvalClient, "Acme Home");
  assert.equal(tab.approvalClient, "a coding agent");
  tab.close();
});
