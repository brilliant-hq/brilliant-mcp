// helper.js: the top-level orchestrator each stdio process runs. It elects a
// role (leader or follower), exposes ONE seam, `dispatch(raw) -> reply`, and
// re-elects transparently when the leader exits. The stdio and CLI layers know
// nothing of leadership; they just call dispatch.

import {
  acquireElectionLock,
  readLeader,
  leaderIsStale,
  releaseElectionLock,
} from "./state.js";
import { startLeader } from "./leader.js";
import { forwardToLeader, requestStepDown } from "./follower.js";
import { compareVersions, log, newSessionId, ownVersion } from "./util.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createHelper(opts = {}) {
  const sessionId = opts.sessionId || newSessionId();
  // The bytes THIS process is running. Stamped into our lease when we lead, and
  // compared against a sitting leader's stamp so a helper carrying fresher bytes
  // never quietly follows a stale leader.
  const myVersion = opts.version || ownVersion();
  let role = null; // "leader" | "follower"
  let leader = null; // leader control object when role === "leader"
  let leaderInfo = null; // leader.json snapshot when role === "follower"
  let electing = null; // shared election promise (avoid concurrent elections)

  // When a newer peer unseats us, the leader invokes this so we re-elect and
  // rejoin as a follower of the new leader on our next dispatch.
  const onStepDown = () => {
    role = null;
    leader = null;
    leaderInfo = null;
  };

  function becomeLeader() {
    return startLeader({ ...(opts.leaderOpts || {}), version: myVersion, onStepDown });
  }

  /** True when the sitting leader runs OLDER bytes than we do. An UNSTAMPED lease
   *  predates the durability fix, so it is treated as older (a fixed helper must
   *  be able to retire it). */
  function leaderRunsOlderBytes(existing) {
    if (!existing || typeof existing.version !== "string") return true;
    return compareVersions(existing.version, myVersion) < 0;
  }

  async function elect() {
    if (electing) return electing;
    electing = (async () => {
      // Bounded passes: each either settles a role or contends once and retries.
      for (let pass = 0; pass < 4; pass++) {
        const existing = readLeader();
        if (existing && !leaderIsStale(existing)) {
          // Our own leadership (we lost the file but are still the leader).
          if (leader && existing.pid === process.pid) {
            role = "leader";
            return;
          }
          // A leader whose bytes are as fresh as ours (or fresher): follow it.
          if (!leaderRunsOlderBytes(existing)) {
            role = "follower";
            leaderInfo = existing;
            return;
          }
          // The live leader runs OLDER bytes. Fresh bytes must win: ask it to
          // step down (graceful yield), then take over. clearLeader's pid guard
          // makes the lease-clear race with our own writeLeader harmless.
          const res = await requestStepDown(existing, myVersion);
          const refusedAsNewer =
            res && res.ok === false && typeof res.version === "string" && compareVersions(res.version, myVersion) >= 0;
          if (refusedAsNewer) {
            // The sitting leader is in fact newer-or-equal; follow it.
            role = "follower";
            leaderInfo = readLeader() || existing;
            return;
          }
          if (acquireElectionLock()) {
            try {
              leader = await becomeLeader();
              role = "leader";
              log(`took over from an older leader (v${existing.version || "?"} -> v${myVersion})`);
            } finally {
              releaseElectionLock();
            }
            return;
          }
          // Lost the lock to another fresh peer: wait, then loop to follow it.
          await sleep(150);
          continue;
        }
        // No live leader: contend for the lock and become leader.
        if (acquireElectionLock()) {
          try {
            leader = await becomeLeader();
            role = "leader";
            log(`became leader (ws ${leader.wsPort}, rpc ${leader.rpcPort}, session ${sessionId})`);
          } finally {
            releaseElectionLock();
          }
          return;
        }
        // Someone else is electing: wait briefly, then loop to follow the winner.
        await sleep(150);
      }
      // Passes exhausted: best-effort follow (a later dispatch re-elects).
      const final = readLeader();
      role = "follower";
      leaderInfo = final;
    })();
    try {
      await electing;
    } finally {
      electing = null;
    }
  }

  await elect();

  async function dispatch(raw) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (role === "leader") {
        return leader.handle(raw, sessionId);
      }
      try {
        return await forwardToLeader(leaderInfo, raw, sessionId);
      } catch (e) {
        // Leader unreachable or token rotated: re-elect and retry.
        log(`leader unreachable (${e.code || e.message}): re-electing`);
        role = null;
        leader = null;
        leaderInfo = null;
        await elect();
      }
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "no leader could be reached after re-election" },
    });
  }

  async function close() {
    if (role === "leader" && leader) await leader.close();
  }

  return {
    dispatch,
    close,
    get role() {
      return role;
    },
    get leader() {
      return leader;
    },
    get leaderInfo() {
      return leaderInfo;
    },
    sessionId,
  };
}
