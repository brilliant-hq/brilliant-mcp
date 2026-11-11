// follower.js: a non-leader helper instance. Every MCP client spawns its own
// stdio helper; all but the first become followers and forward each JSON-RPC
// message, verbatim, to the leader's loopback /rpc endpoint, streaming the
// reply back over their own stdio. The frozen /rpc body is {token, payload};
// the agent-session id rides an X-Brilliant-Session header (transport detail,
// so the frozen body stays byte-exact) so the leader binds each session.

import http from "node:http";
import { LOOPBACK } from "./util.js";

/** POST one JSON-RPC payload string to the leader's /rpc, returning the reply
 *  string. Rejects (with .code preserved) when the leader is unreachable: the
 *  caller re-elects. */
export function forwardToLeader(leaderInfo, payload, sessionId, { timeoutMs = 130_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ token: leaderInfo.token, payload }), "utf8");
    const req = http.request(
      {
        host: LOOPBACK,
        port: leaderInfo.rpcPort,
        path: "/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-brilliant-session": sessionId,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 403) return reject(Object.assign(new Error("leader rejected token"), { code: "EBADTOKEN" }));
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("rpc timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });
}

/** Ask the sitting leader to step down because WE carry newer bytes (the
 *  version-handoff channel: POST /control {token, op:'step-down', version}). The
 *  leader yields ONLY if our version is strictly greater than its own, then
 *  drops its lease + sockets so we can take over.
 *  Best-effort and bounded: any failure (leader gone, pre-`/control` leader that
 *  404s, refusal) resolves { ok:false } and the caller contends anyway (an
 *  unreachable leader is effectively dead). NEVER rejects. */
export function requestStepDown(leaderInfo, version, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ token: leaderInfo.token, op: "step-down", version }), "utf8");
    const req = http.request(
      {
        host: LOOPBACK,
        port: leaderInfo.rpcPort,
        path: "/control",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed && typeof parsed === "object" ? parsed : { ok: false });
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve({ ok: false }));
    req.end(body);
  });
}
