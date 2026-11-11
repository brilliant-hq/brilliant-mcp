// state.js: the on-disk state dir. One leader daemon per machine writes
// leader.json (its ports + the follower-auth token, mode 0600); approved helper
// associations persist here too. THE TAB NEVER READS THIS DIR (the rule:
// the token is never obtainable from any local endpoint or shared file the web
// side can reach: only from the URL fragment or a tab-minted association).
//
// Every path honors BRILLIANT_MCP_STATE_DIR so tests stay hermetic (a temp dir,
// never the real ~/.config/brilliant).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The state dir: env override, else ~/.config/brilliant/mcp-helper (the same
 *  root the Brilliant apps use on every platform). */
export function stateDir() {
  const override = process.env.BRILLIANT_MCP_STATE_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".config", "brilliant", "mcp-helper");
}

function ensureDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function leaderPath() {
  return path.join(stateDir(), "leader.json");
}

function associationsPath() {
  return path.join(stateDir(), "associations.json");
}

function electionLockPath() {
  return path.join(stateDir(), "election.lock");
}

function toolsCachePath() {
  return path.join(stateDir(), "tools-cache.json");
}

/** Atomic + private write: temp file (0600) then rename over the target. */
function writePrivateJson(file, obj) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename preserves the temp file's mode; belt-and-suspenders re-chmod.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

/** Read leader.json, or null if absent/corrupt. */
export function readLeader() {
  try {
    return JSON.parse(fs.readFileSync(leaderPath(), "utf8"));
  } catch {
    return null;
  }
}

/** Write leader.json {pid, port, rpcPort, token, version}. `port` is the
 *  discoverable ws fallback port; the ephemeral handoff port is NEVER persisted
 *  (it lives only in the URL fragment; a port is never permanent protocol).
 *  `version` is the leader's OWN running version so a peer carrying fresher
 *  bytes can tell it is stale and force a handoff. */
export function writeLeader({ pid, port, rpcPort, token, version }) {
  writePrivateJson(leaderPath(), { pid, port, rpcPort, token, version });
}

/** Remove leader.json (leader shutdown). Best effort. */
export function clearLeader(expectPid) {
  try {
    if (expectPid !== undefined) {
      const cur = readLeader();
      if (cur && cur.pid !== expectPid) return; // someone else owns it now
    }
    fs.unlinkSync(leaderPath());
  } catch {
    /* already gone */
  }
}

/** A pid is alive if signal-0 succeeds (or fails with EPERM: alive, not ours). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** A lease is stale (takeable) when it is missing or its pid is dead. */
export function leaderIsStale(leader) {
  if (!leader || typeof leader.pid !== "number") return true;
  return !pidAlive(leader.pid);
}

/** Try to claim the single-writer election lock. Returns true if acquired.
 *  O_EXCL create; a lock whose owning pid is dead (or older than ttlMs) is
 *  reclaimed once so a crashed elector never wedges the machine. */
export function acquireElectionLock(ttlMs = 10_000) {
  ensureDir();
  const file = electionLockPath();
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    fs.writeFileSync(file, payload, { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  // Lock exists: reclaim only if its owner is dead or it is older than ttl.
  let stale = false;
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    stale = !pidAlive(held.pid) || Date.now() - (held.at || 0) > ttlMs;
  } catch {
    stale = true; // unreadable lock is treated as stale
  }
  if (!stale) return false;
  try {
    fs.unlinkSync(file);
    fs.writeFileSync(file, payload, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function releaseElectionLock() {
  try {
    fs.unlinkSync(electionLockPath());
  } catch {
    /* already released */
  }
}

/** Read the persisted approved associations (KeePassXC-lite): an array of
 *  { association, client, addedAt } records. */
export function readAssociations() {
  try {
    const parsed = JSON.parse(fs.readFileSync(associationsPath(), "utf8"));
    return Array.isArray(parsed.associations) ? parsed.associations : [];
  } catch {
    return [];
  }
}

/** True if `secret` matches any persisted association. */
export function isKnownAssociation(secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  return readAssociations().some((a) => a.association === secret);
}

/** Persist a newly approved association secret (dedup by secret). */
export function addAssociation(secret, client) {
  if (typeof secret !== "string" || secret.length === 0) return;
  const existing = readAssociations();
  if (existing.some((a) => a.association === secret)) return;
  existing.push({ association: secret, client: client || null, addedAt: Date.now() });
  writePrivateJson(associationsPath(), { associations: existing });
}

/** The last tools/list RESULT a surface answered (`{ tools: [...] }`), or null.
 *  A new agent session's discovery call is answered from it when no surface is
 *  connected, so session start never opens a pairing tab. It
 *  holds tool schemas only, never a token or an association. Keyed by the
 *  helper version that wrote it: a list kept by other helper bytes is never
 *  served (the next pairing refreshes it). */
export function readToolsCache(version) {
  try {
    const parsed = JSON.parse(fs.readFileSync(toolsCachePath(), "utf8"));
    if (!parsed || parsed.version !== version) return null;
    return Array.isArray(parsed.tools) && parsed.tools.length > 0 ? { tools: parsed.tools } : null;
  } catch {
    return null;
  }
}

/** Persist a surface's tools/list result under the writing helper's version.
 *  Best effort: a failed write only means the next session's discovery pairs
 *  again. */
export function writeToolsCache(result, version) {
  if (!result || !Array.isArray(result.tools) || result.tools.length === 0) return;
  try {
    writePrivateJson(toolsCachePath(), { version, tools: result.tools });
  } catch {
    /* best effort */
  }
}

/** The tool list this package ships (`lib/tools_snapshot.json`, generated from
 *  the Brilliant release tool registry), or null when the file is missing or
 *  unreadable. A discovery call with no surface and no kept list is answered
 *  from it, so a first run, a registry crawler or a reviewer running the
 *  package cold gets the real tool list and nothing opens. A surface's own
 *  list always wins: it is kept on every pairing and served before this one. */
export function readToolsSnapshot() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "tools_snapshot.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.tools) && parsed.tools.length > 0 ? { tools: parsed.tools } : null;
  } catch {
    return null;
  }
}
