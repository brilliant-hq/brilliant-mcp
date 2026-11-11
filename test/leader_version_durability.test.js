// leader_version_durability.test.js: a helper elected via `npx -y` pins
// whatever @brilliant-hq/mcp version its npx cache held at spawn, so a stale
// leader can serve a fixed bug for days after a newer version publishes (field
// a 13-day-old 0.1.6 leader shipped a fixed bug for 3 days;
// 171 desktop-probe-timeouts unnoticed). The durability contract: a helper that
// carries NEWER bytes than the live leader must NOT quietly follow it; it forces
// a handoff (the older leader steps down and rejoins as a follower) so fresh
// bytes always win. An OLDER helper still follows a newer leader. The leader now
// stamps its version in leader.json.

import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
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

async function mk(version) {
  const h = await createHelper({ version, leaderOpts: FAST });
  live.push(h);
  return h;
}

test("the leader stamps its version into leader.json", async () => {
  const a = await mk("0.1.7");
  assert.equal(a.role, "leader");
  assert.equal(state.readLeader().version, "0.1.7", "leader.json carries the leader's version");
});

test("a helper carrying NEWER bytes forces a handoff: the older leader steps down and the newer helper takes over", async () => {
  const older = await mk("0.1.6");
  assert.equal(older.role, "leader");
  assert.equal(state.readLeader().version, "0.1.6");

  // A second helper spawns with fresher bytes (the npx cache refreshed to 0.1.7).
  const newer = await mk("0.1.7");
  assert.equal(newer.role, "leader", "the newer helper must NOT quietly follow the older leader");

  const lj = state.readLeader();
  assert.equal(lj.version, "0.1.7", "leader.json now names the fresh-bytes leader");
  assert.equal(lj.rpcPort, newer.leader.rpcPort, "the discoverable leader is the newer helper");

  // The displaced older helper rejoins as a follower of the newer leader on its
  // next dispatch (it re-elects lazily; ping is answered locally by whoever it
  // now follows).
  await older.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal(older.role, "follower", "the stepped-down leader rejoins as a follower");
  assert.equal(older.leaderInfo.rpcPort, newer.leader.rpcPort, "it follows the newer leader");
});

test("an OLDER helper follows a NEWER leader (fresh bytes are never displaced by stale ones)", async () => {
  const newer = await mk("0.1.7");
  assert.equal(newer.role, "leader");

  const older = await mk("0.1.6");
  assert.equal(older.role, "follower", "an older helper follows the newer leader, never kicks it out");
  assert.equal(older.leaderInfo.version, "0.1.7");
});

test("an EQUAL-version helper follows the sitting leader (no needless churn)", async () => {
  const a = await mk("0.1.7");
  assert.equal(a.role, "leader");
  const b = await mk("0.1.7");
  assert.equal(b.role, "follower", "an equal-version helper just follows");
  assert.equal(b.leaderInfo.rpcPort, a.leader.rpcPort);
});
