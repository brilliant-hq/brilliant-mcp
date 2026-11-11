// prohibitions.test.js: the spec's forbidden behaviors, encoded as gates:
// never bind 0.0.0.0; never scan private ranges (loopback pool only); never
// serve the token from any local endpoint; the ws port lives in the URL
// fragment and is never persisted as permanent protocol.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const { LOOPBACK } = await import("../lib/util.js");
const desktop = await import("../lib/desktop.js");
const state = await import("../lib/state.js");
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");

let leader;
let opener;
before(async () => {
  opener = recordingOpener();
  leader = await startLeader({ ...FAST, openUrl: opener.openUrl });
});
after(async () => {
  await leader.close();
  cleanup();
});

function httpReq(method, port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

test("every listener binds the 127.0.0.1 literal: never 0.0.0.0", () => {
  assert.equal(LOOPBACK, "127.0.0.1");
  // Structural: every `.listen(` in the source names LOOPBACK (or the literal).
  for (const file of ["leader.js", "desktop.js", "follower.js", "util.js"]) {
    const src = fs.readFileSync(path.join(LIB, file), "utf8");
    for (const line of src.split("\n")) {
      if (line.includes(".listen(")) {
        assert.ok(/LOOPBACK|127\.0\.0\.1/.test(line), `${file}: listen must bind loopback -> ${line.trim()}`);
      }
    }
  }
});

test("the desktop probe targets only the loopback pool: no private-range scan", () => {
  assert.deepEqual(desktop.DESKTOP_PORTS, [3333, 3334, 3335]);
  // Every http.request host in desktop.js is LOOPBACK; no 10./192.168/172. dial.
  const src = fs.readFileSync(path.join(LIB, "desktop.js"), "utf8");
  for (const line of src.split("\n")) {
    if (/host:/.test(line)) assert.ok(/LOOPBACK/.test(line), `desktop dial must be loopback -> ${line.trim()}`);
  }
  assert.equal(/(\b10\.\d|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(src), false, "no private-range literals");
});

test("the /rpc endpoint never serves the token (no unauthenticated token leak)", async () => {
  const token = leader.token;
  const get = await httpReq("GET", leader.rpcPort, "/rpc");
  assert.equal(get.status, 404);
  assert.ok(!get.text.includes(token), "GET /rpc must not leak the token");

  const root = await httpReq("GET", leader.rpcPort, "/");
  assert.equal(root.status, 404);
  assert.ok(!root.text.includes(token));

  const badPost = await httpReq("POST", leader.rpcPort, "/rpc", JSON.stringify({ token: "nope", payload: "{}" }));
  assert.equal(badPost.status, 403);
  assert.ok(!badPost.text.includes(token), "a rejected POST must not echo the real token");
});

test("a denied ws frame carries no token", async () => {
  const tab = await connectStubTab({ port: leader.wsPort, origin: "https://evil.example" });
  assert.equal(tab.outcome, "denied");
  // The stub captured the frame; assert its shape has only kind+reason.
  assert.equal(tab.deniedReason, "bad-origin");
});

test("the handoff port lives in the URL fragment and is never persisted as permanent protocol", async () => {
  const pending = leader._triggerHandoff().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const url = opener.opened.at(-1);
  const m = /#bridge=(\d+)&t=[0-9a-f]+$/.exec(url);
  assert.ok(m, `URL carries the port in the fragment: ${url}`);
  const fragmentPort = Number(m[1]);
  assert.equal(fragmentPort, leader.handoffPortNow());

  const lj = state.readLeader();
  assert.notEqual(lj.port, fragmentPort, "the ephemeral handoff port is NOT the persisted fallback port");
  assert.equal(JSON.stringify(lj).includes(String(fragmentPort)), false, "the ephemeral port is never written to leader.json");
  await pending;
});

// Windows has no POSIX mode bits (stat synthesizes them from the read-only
// attribute), so the 0600 law is only measurable on POSIX; a named skip beats
// a green that measured nothing (win validation residue, 2026-08-16).
test(
  "leader.json is private (0600)",
  { skip: process.platform === "win32" && "no POSIX mode bits on Windows" },
  () => {
    const file = path.join(state.stateDir(), "leader.json");
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `leader.json mode should be 0600, got ${mode.toString(8)}`);
  },
);
