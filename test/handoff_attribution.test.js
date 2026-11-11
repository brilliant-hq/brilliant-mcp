// handoff_attribution.test.js: the pairing URL says which door an install came
// from, and nothing else. utm_source is always mcp-helper, utm_medium is the
// MCP client's own name, utm_content is the door tag of the install snippet
// (--src or BRILLIANT_MCP_SRC). The port and token stay in the fragment.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";

const cleanup = hermeticEnv();
const { startLeader, handoffUrl, attributionTag } = await import("../lib/leader.js");
after(cleanup);

const call = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "init", arguments: {} } });
const init = (id, name) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name, version: "1" } } });

async function openedUrl(opts, clientName) {
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, handoffTimeoutMs: 150, openUrl: opener.openUrl, toolsSnapshot: () => null, ...opts });
  try {
    if (clientName) await leader.handle(init(1, clientName), "s1");
    await leader.handle(call(2), "s1"); // no tab answers: the handoff times out
    assert.equal(opener.opened.length, 1);
    return new URL(opener.opened[0]);
  } finally {
    await leader.close();
  }
}

test("the pairing URL carries the source, the client and the door tag; the token stays in the fragment", async () => {
  const url = await openedUrl({ src: "cursor-button" }, "claude-code");
  assert.equal(url.origin + url.pathname, "https://brilliant.design/playground");
  assert.deepEqual([...url.searchParams.entries()], [["utm_source", "mcp-helper"], ["utm_medium", "claude-code"], ["utm_content", "cursor-button"]]);
  assert.match(url.hash, /^#bridge=\d+&t=[0-9a-f]+$/);
  assert.ok(!url.search.includes("bridge") && !/[?&]t=/.test(url.search), "nothing of the pairing secret is in the query");
});

test("no client name and no tag: only the source rides", async () => {
  const url = await openedUrl({ src: "" }, null);
  assert.equal(url.search, "?utm_source=mcp-helper");
});

test("the door tag comes from BRILLIANT_MCP_SRC when no option is passed", async () => {
  process.env.BRILLIANT_MCP_SRC = "claude-plugin";
  try {
    const url = await openedUrl({}, "cursor");
    assert.equal(url.searchParams.get("utm_content"), "claude-plugin");
  } finally {
    delete process.env.BRILLIANT_MCP_SRC;
  }
});

test("a client's self-reported name is never trusted as URL text", () => {
  assert.equal(attributionTag("Claude Code (1.2)"), "Claude-Code-1.2");
  assert.equal(attributionTag("x&utm_source=evil#bridge=1&t=aa"), "x-utm_source-evil-bridge-1-t-aa");
  assert.equal(attributionTag("a".repeat(200)).length, 64);
  assert.equal(attributionTag(42), "");
  const url = new URL(handoffUrl("https://brilliant.design/playground", { port: 5, token: "ab", client: "x&y=z#h", src: "?q" }));
  assert.equal(url.searchParams.get("utm_medium"), "x-y-z-h");
  assert.equal(url.searchParams.get("utm_content"), "q");
  assert.equal(url.hash, "#bridge=5&t=ab");
});
