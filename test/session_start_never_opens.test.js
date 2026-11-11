// session_start_never_opens.test.js: a new agent session never opens Brilliant
// unasked (a field report: "every time I open a new Claude
// session it opens brilliant").
//
// The mechanism: every MCP client sends tools/list on its own at session start.
// With no surface connected, the helper used to treat that discovery call like
// a tool call and open https://brilliant.design/playground in the browser, once
// per session (the leader dies with its session, the next session elects a
// fresh one), and even while the desktop app was running when the app started
// after the leader probed for it.
//
// THE LAW:
//   (a) the desktop app answering on the pool is a surface: no open, ever.
//   (b) discovery (tools/list) never opens a tab once the helper has seen the
//       tool list before: it answers from the cached list. Only a tools/call
//       (the agent acting) may open the pairing tab.
//   (c) the first-ever discovery (no cached list) is answered from the tool
//       list the package ships and opens nothing either: a first run, a
//       registry crawler or a reviewer running the package cold gets the real
//       list. A surface's own list, once kept, is served before the shipped one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { startStubDesktop } from "./helpers/stub_desktop.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const STATE = process.env.BRILLIANT_MCP_STATE_DIR;
const { startLeader } = await import("../lib/leader.js");
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "brilliant-mcp.js");

const SHIPPED = { tools: JSON.parse(fs.readFileSync(new URL("../lib/tools_snapshot.json", import.meta.url), "utf8")).tools };

const stubs = [];
const tempDirs = [];
after(async () => {
  for (const s of stubs) await s.close();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  cleanup();
});

async function waitFor(pred, ms = 2000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const list = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
const call = (id) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_html", arguments: { a: 1 } } });

function freshStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brilliant-mcp-launch-"));
  process.env.BRILLIANT_MCP_STATE_DIR = dir;
  tempDirs.push(dir);
  return dir;
}

test("(a) the desktop app started after the leader: tools/list connects to it and opens nothing", async () => {
  freshStateDir();
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  let appRunning = false; // the app is not up when the leader probes at election
  const opener = recordingOpener();
  const leader = await startLeader({
    ...FAST,
    openUrl: opener.openUrl,
    detectDesktop: async () => (appRunning ? stub.port : null),
  });
  try {
    appRunning = true; // the user launches Brilliant, then opens a new session
    const reply = JSON.parse(await leader.handle(list(1), "session-1"));
    assert.deepEqual(opener.opened, [], "a running desktop app is connected to, never opened over");
    assert.equal(reply.result && reply.result.tools[0].name, "desktop_tool", "the app answers the session's tools/list");
    const callReply = JSON.parse(await leader.handle(call(2), "session-1"));
    assert.match(callReply.result.content[0].text, /^desktop-echo:/);
    assert.deepEqual(opener.opened, []);
  } finally {
    await leader.close();
  }
});

test("(b) after a first pairing, a new session's tools/list answers from the cached list and opens nothing", async () => {
  freshStateDir();
  // Session 1 (the first run): the agent's first tool call pairs a tab, and
  // the tab's own list is what a listing then answers and keeps.
  const openerA = recordingOpener();
  const leaderA = await startLeader({ ...FAST, openUrl: openerA.openUrl });
  try {
    const p = leaderA.handle(call(1), "session-1");
    await waitFor(() => openerA.opened.length > 0, 2000, "first-run handoff");
    const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(openerA.opened.at(-1));
    const tab = await connectStubTab({ port: Number(m[1]), token: m[2], tabId: "first-run-tab" });
    assert.equal(tab.outcome, "accepted");
    await p;
    const first = JSON.parse(await leaderA.handle(list(11), "session-1"));
    assert.equal(first.result.tools[0].name, "create_html");
    tab.close();
  } finally {
    await leaderA.close();
  }

  // Sessions 2, 3 and 4: each a fresh leader (the old one died with its
  // session), no tab, no app. Discovery must not open anything.
  for (const n of [2, 3, 4]) {
    const opener = recordingOpener();
    const leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
    try {
      const reply = JSON.parse(await leader.handle(list(n), `session-${n}`));
      assert.deepEqual(opener.opened, [], `session ${n}: tools/list opened nothing`);
      assert.equal(reply.id, n);
      assert.equal(reply.result && reply.result.tools[0].name, "create_html", `session ${n}: the cached list answers`);
    } finally {
      await leader.close();
    }
  }
});

test("(b) a tools/call with no surface still opens the pairing tab: the agent acting is the ask", async () => {
  // Same state dir as the cell above: the cache exists, so only the call opens.
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
  try {
    const p = leader.handle(call(9), "session-9");
    await waitFor(() => opener.opened.length > 0, 2000, "call handoff");
    assert.match(opener.opened[0], /^https:\/\/brilliant\.design\/playground\?utm_source=mcp-helper#bridge=/);
    const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(opener.opened[0]);
    const tab = await connectStubTab({ port: Number(m[1]), token: m[2], tabId: "call-tab" });
    const reply = JSON.parse(await p);
    assert.match(reply.result.content[0].text, /^echo:/);
    tab.close();
  } finally {
    await leader.close();
  }
});

test("(c) the first-ever discovery with no kept list answers the shipped tool list and opens nothing", async () => {
  freshStateDir();
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
  try {
    const reply = JSON.parse(await leader.handle(list(1), "session-first"));
    assert.deepEqual(opener.opened, [], "a cold discovery opens nothing");
    assert.deepEqual(reply.result, SHIPPED, "the list the package ships, verbatim");
    assert.equal(fs.existsSync(path.join(process.env.BRILLIANT_MCP_STATE_DIR, "tools-cache.json")), false, "the shipped list is never written as a surface's list");
  } finally {
    await leader.close();
  }
});

test("(c) a package with no shipped list still pairs once on the first discovery", async () => {
  freshStateDir();
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, openUrl: opener.openUrl, toolsSnapshot: () => null });
  try {
    const reply = JSON.parse(await leader.handle(list(1), "session-first"));
    assert.equal(opener.opened.length, 1, "exactly one pairing tab on the first run");
    assert.ok(reply.error, "no tab answered within the handoff window");
  } finally {
    await leader.close();
  }
});

test("(c) the shipped list is the release surface: the doors are there, no dev tool is", () => {
  const names = SHIPPED.tools.map((t) => t.name);
  for (const door of ["init", "edit", "read", "export", "get_knowledge"]) assert.ok(names.includes(door), `${door} is listed`);
  assert.deepEqual(names.filter((n) => /^(sim_|gesture$|probe$|instrument$)/.test(n)), [], "no dev-only tool ships");
  for (const t of SHIPPED.tools) {
    assert.equal(t.inputSchema && t.inputSchema.type, "object", `${t.name} carries an input schema`);
    assert.ok(t.annotations && typeof t.annotations.title === "string" && t.annotations.title.length > 0, `${t.name} carries a title`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", `${t.name} readOnlyHint`);
    assert.equal(typeof t.annotations.destructiveHint, "boolean", `${t.name} destructiveHint`);
  }
});

test("(d) a pairing refreshes the cache on its own: a tab paired by a tools/call serves the next session's discovery", async () => {
  freshStateDir();
  const state = await import("../lib/state.js");
  const openerA = recordingOpener();
  const leaderA = await startLeader({ ...FAST, openUrl: openerA.openUrl, version: "9.9.9" });
  try {
    const p = leaderA.handle(call(1), "session-1");
    await waitFor(() => openerA.opened.length > 0, 2000, "call handoff");
    const m = /#bridge=(\d+)&t=([0-9a-f]+)$/.exec(openerA.opened[0]);
    const tab = await connectStubTab({ port: Number(m[1]), token: m[2], tabId: "paired-by-call" });
    await p;
    // The agent never listed: the pairing alone fetched and kept the list.
    await waitFor(() => state.readToolsCache("9.9.9"), 2000, "cache written on pairing");
    tab.close();
  } finally {
    await leaderA.close();
  }
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, openUrl: opener.openUrl, version: "9.9.9" });
  try {
    const reply = JSON.parse(await leader.handle(list(2), "session-2"));
    assert.deepEqual(opener.opened, []);
    assert.equal(reply.result.tools[0].name, "create_html");
  } finally {
    await leader.close();
  }
});

test("(e) a list kept by other helper bytes is never served: the shipped list answers instead", async () => {
  freshStateDir();
  const state = await import("../lib/state.js");
  state.writeToolsCache({ tools: [{ name: "old_tool", inputSchema: { type: "object" } }] }, "9.9.9");
  assert.ok(state.readToolsCache("9.9.9"), "the older helper's list is on disk");
  const opener = recordingOpener();
  const leader = await startLeader({ ...FAST, openUrl: opener.openUrl, version: "10.0.0" });
  try {
    const reply = JSON.parse(await leader.handle(list(3), "session-3"));
    assert.deepEqual(opener.opened, []);
    assert.deepEqual(reply.result, SHIPPED, "a newer helper never answers from an older helper's list");
  } finally {
    await leader.close();
  }
});

// The real stdio shim, spawned as a client spawns it, with a fake opener and a
// fake app port. The app comes up AFTER the shim elected itself leader (the
// field order: the agent session was already open when Brilliant launched,
// then a new session joins).
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("(a) the spawned shim with the app running never calls the opener", async () => {
  const dir = freshStateDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brilliant-mcp-home-"));
  tempDirs.push(home);
  const openLog = path.join(dir, "opened.log");
  const opener = path.join(dir, "fake-open.sh");
  fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${openLog}"\n`, { mode: 0o755 });
  const appPort = await freePort();

  const child = spawn(process.execPath, [BIN], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      BRILLIANT_MCP_STATE_DIR: dir,
      BRILLIANT_MCP_DESKTOP_PORTS: String(appPort),
      BRILLIANT_MCP_OPENER: opener,
      BRILLIANT_MCP_WS_PORTS: "0",
      BRILLIANT_MCP_QUIET: "1",
      BRILLIANT_MCP_HANDOFF_TIMEOUT_MS: "800",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      } catch {
        /* not a frame */
      }
    }
  });
  try {
    await waitFor(() => fs.existsSync(path.join(dir, "leader.json")), 4000, "shim elected");
    // Let the shim's own election probe miss the (not yet running) app.
    await new Promise((r) => setTimeout(r, 300));
    const stub = await startStubDesktop({ serverName: "brilliant", port: appPort });
    stubs.push(stub);

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => replies.has(1) && replies.has(2), 4000, "replies 1,2");
    // Give a detached opener a beat to write, if it was spawned at all.
    await new Promise((r) => setTimeout(r, 200));
    const opened = fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8").trim() : "";
    assert.equal(opened, "", "the shim never opened anything while the app was running");
    assert.equal(replies.get(2).result && replies.get(2).result.tools[0].name, "desktop_tool");
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
});

test("(c) the spawned shim, cold (no app, no tab, empty state): initialize then tools/list answers the list and opens nothing", async () => {
  const dir = freshStateDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brilliant-mcp-home-"));
  tempDirs.push(home);
  const openLog = path.join(dir, "opened.log");
  const opener = path.join(dir, "fake-open.sh");
  fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${openLog}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [BIN], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      BRILLIANT_MCP_STATE_DIR: dir,
      BRILLIANT_MCP_DISABLE_DESKTOP: "1",
      BRILLIANT_MCP_OPENER: opener,
      BRILLIANT_MCP_WS_PORTS: "0",
      BRILLIANT_MCP_QUIET: "1",
      BRILLIANT_MCP_HANDOFF_TIMEOUT_MS: "800",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.set(msg.id, msg);
    }
  });
  try {
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "registry-crawler", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => replies.has(1) && replies.has(2), 4000, "replies 1,2");
    await new Promise((r) => setTimeout(r, 200));
    const opened = fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8").trim() : "";
    assert.equal(opened, "", "a cold listing opened nothing");
    assert.equal(replies.get(1).result.serverInfo.name, "brilliant");
    assert.deepEqual(replies.get(2).result, SHIPPED);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
});
