// cold_start.test.js: what a person sees who pastes the connect line with no
// Brilliant open. A field gate measured the old behaviour: tools/list hung for
// two minutes and answered an error with zero tools. The law now:
//   1. tools/list answers at once from the shipped list (also pinned in
//      session_start_never_opens.test.js).
//   2. a tool call opens the pairing tab and answers within the pair wait with
//      a plain instruction as a tool result; the pairing stays open, so the
//      retry lands on the tab.
//   3. serverInfo.version is the helper's own version.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
after(cleanup);

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const call = (id) => rpc(id, "tools/call", { name: "init", arguments: {} });

test("cold: initialize reports the helper version and tools/list answers at once, opening nothing", async () => {
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, handoffTimeoutMs: 120_000, openUrl: opener.openUrl, version: "7.7.7" });
  try {
    const init = JSON.parse(await leader.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }), "s"));
    assert.equal(init.result.serverInfo.version, "7.7.7");
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const t0 = Date.now();
    const list = JSON.parse(await leader.handle(rpc(2, "tools/list"), "s"));
    assert.ok(Date.now() - t0 < 500, "no wait on a cold listing");
    assert.ok(list.result.tools.length > 0);
    assert.deepEqual(opener.opened, []);
  } finally {
    await leader.close();
  }
});

test("cold: a tool call answers within the pair wait with the instruction, and the retry lands on the tab that paired meanwhile", async () => {
  const opener = recordingOpener();
  // The production handoff window (two minutes); only the pair wait is short.
  const leader = await startLeader({ ...FAST, handoffTimeoutMs: 120_000, pairWaitMs: 150, openUrl: opener.openUrl });
  try {
    const t0 = Date.now();
    const first = JSON.parse(await leader.handle(call(1), "s"));
    assert.ok(Date.now() - t0 < 2000, "the call does not hang for the handoff window");
    assert.equal(opener.opened.length, 1, "the pairing tab opened");
    assert.equal(first.error, undefined, "a tool result, not a JSON-RPC error");
    assert.equal(first.result.isError, true);
    const text = first.result.content[0].text;
    assert.match(text, /https:\/\/brilliant\.design\/playground/);
    assert.match(text, /Chrome, Edge or Firefox/);
    assert.match(text, /desktop app/);
    assert.match(text, /local\s+network prompt/);
    assert.match(text, /run this call again/);
    assert.ok(!/\u2014/.test(text));

    // A second call while the user is still approving opens no second tab.
    await leader.handle(call(2), "s");
    assert.equal(opener.opened.length, 1, "one pairing tab, however many calls");

    // The user allows the prompt: the tab pairs on the still-open handoff.
    const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(opener.opened[0]);
    const tab = await connectStubTab({ port: Number(m[1]), token: m[2], tabId: "late-tab" });
    assert.equal(tab.outcome, "accepted");
    const retry = JSON.parse(await leader.handle(call(3), "s"));
    assert.match(retry.result.content[0].text, /^echo:/, "the retry is relayed to the tab");
    assert.equal(opener.opened.length, 1);
    tab.close();
  } finally {
    await leader.close();
  }
});

test("the default pair wait is a few seconds", async () => {
  const leader = await startLeader({ ...FAST, openUrl: () => {} });
  try {
    assert.ok(leader._config.pairWaitMs >= 3000 && leader._config.pairWaitMs <= 10000);
  } finally {
    await leader.close();
  }
});
