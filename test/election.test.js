// election.test.js: leader/follower election and stale-lease takeover. The
// first instance claims leadership and writes leader.json {pid,port,rpcPort,
// token}; a second instance sees the live leader and follows; a lease whose pid
// is dead is taken over.

import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { hermeticEnv, FAST } from "./helpers/env.js";

const cleanup = hermeticEnv();
const state = await import("../lib/state.js");
const { createHelper } = await import("../lib/helper.js");

const live = [];
beforeEach(() => {
  state.clearLeader();
  state.releaseElectionLock();
});
afterEach(async () => {
  while (live.length) {
    const h = live.pop();
    try {
      await h.close();
    } catch {
      /* best effort */
    }
  }
  state.clearLeader();
  state.releaseElectionLock();
});
after(() => cleanup());

async function mk() {
  const h = await createHelper({ leaderOpts: FAST });
  live.push(h);
  return h;
}

/** A pid that is definitely dead: spawn a node, kill it, wait for exit. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((r) => {
    child.on("exit", r);
    child.kill("SIGKILL");
  });
  return pid;
}

test("the first instance becomes leader and writes a well-formed leader.json", async () => {
  const h = await mk();
  assert.equal(h.role, "leader");
  const lj = state.readLeader();
  assert.equal(lj.pid, process.pid);
  assert.ok(Number.isInteger(lj.port) && lj.port > 0);
  assert.ok(Number.isInteger(lj.rpcPort) && lj.rpcPort > 0);
  assert.match(lj.token, /^[0-9a-f]{64}$/);
});

test("a second instance sees the live leader and becomes a follower", async () => {
  const a = await mk();
  assert.equal(a.role, "leader");
  const b = await mk();
  assert.equal(b.role, "follower");
  assert.equal(b.leaderInfo.rpcPort, a.leader.rpcPort);
  assert.equal(b.leaderInfo.token, a.leader.token);
});

test("a lease with a dead pid is stale and gets taken over", async () => {
  const dead = await deadPid();
  state.writeLeader({ pid: dead, port: 3363, rpcPort: 55999, token: "stale-token" });
  assert.equal(state.leaderIsStale(state.readLeader()), true);

  const h = await mk();
  assert.equal(h.role, "leader", "took over the dead lease");
  const lj = state.readLeader();
  assert.equal(lj.pid, process.pid, "leader.json now names the new leader");
  assert.notEqual(lj.token, "stale-token");
});

test("a live lease is NOT stale", async () => {
  state.writeLeader({ pid: process.pid, port: 3363, rpcPort: 1, token: "t" });
  assert.equal(state.leaderIsStale(state.readLeader()), false);
});

test("the election lock is single-writer", () => {
  assert.equal(state.acquireElectionLock(), true);
  assert.equal(state.acquireElectionLock(), false, "second acquire is refused while held");
  state.releaseElectionLock();
  assert.equal(state.acquireElectionLock(), true, "released lock can be re-acquired");
  state.releaseElectionLock();
});
