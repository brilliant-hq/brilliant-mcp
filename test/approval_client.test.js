// approval_client.test.js: the approval card must name the
// AGENT (its initialize clientInfo.name), never the tab's project. The observed
// bug showed "portfolio wants to drive this session" for a claude-code agent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");

let leader;
before(async () => {
  leader = await startLeader({ ...FAST, openUrl: recordingOpener().openUrl });
});
after(async () => {
  await leader.close();
  cleanup();
});

test("approval-needed.client is the agent's initialize clientInfo.name, never the tab's project", async () => {
  // Relay an initialize carrying the agent's clientInfo (no surface -> local).
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1.0" } },
  });
  await leader.handle(init, "agent-session");

  // A tab dials the fallback lane with no association -> approval names the AGENT,
  // even though the tab's project title is "Portfolio".
  const tab = await connectStubTab({
    port: leader.wsPort,
    autoApprove: false,
    project: { handle: "portfolio", name: "Portfolio", title: "Portfolio" },
  });
  assert.equal(tab.outcome, "approval-needed");
  assert.equal(tab.approvalClient, "claude-code", "names the coding agent");
  assert.notEqual(tab.approvalClient, "Portfolio", "never the tab's project (the observed bug)");
  tab.close();
});
