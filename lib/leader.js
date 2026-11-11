// leader.js: the one daemon. It owns the tab socket(s), the follower /rpc
// endpoint, the surface table and the session-binding table. It is a DUMB
// ROUTER: MCP JSON-RPC crosses it verbatim inside a tiny control envelope; the
// only thing it adds is the _meta.brilliant disclosure on tools/call results
// (it never alters result content). All MCP semantics live in ONE home: the
// MCP dispatcher in the tab, or the desktop app's MCP server.
//
// Wire gates (all mandatory, no exceptions):
//   * every listener binds the 127.0.0.1 literal: never 0.0.0.0.
//   * Origin must be exactly https://brilliant.design (unforgeable from a page).
//   * Host must be loopback (anti-DNS-rebinding).
//   * a hello must carry the fragment token OR a persisted association; a
//     fallback-range connect with neither gets approval-needed and completes
//     only on approve (which persists the association).
//   * the token is NEVER served from any local endpoint.

import http from "node:http";
import { WebSocketServer } from "ws";
import {
  BRILLIANT_ORIGIN,
  LOOPBACK,
  compareVersions,
  isLoopbackHost,
  isNoReply,
  log,
  mintToken,
  openUrl as defaultOpenUrl,
  ownVersion,
  parseMessage,
  rpcError,
  rpcResult,
} from "./util.js";
import {
  addAssociation,
  clearLeader,
  isKnownAssociation,
  readToolsCache,
  readToolsSnapshot,
  writeLeader,
  writeToolsCache,
} from "./state.js";
import { detectDesktop as defaultDetectDesktop, postMcp, parseMaybeSse } from "./desktop.js";

const DEFAULTS = {
  wsPorts: [3363, 3364, 3365], // published fallback probe range (versioned, never permanent)
  helloTimeoutMs: 5_000,
  approvalTimeoutMs: 60_000,
  handoffTimeoutMs: 120_000,
  // How long a call with no surface waits for the pairing tab before it
  // answers with the instruction. The pairing itself stays open for
  // handoffTimeoutMs, so the agent's retry lands on the paired tab.
  pairWaitMs: 8_000,
  callTimeoutMs: 120_000,
  fragmentTokenTtlMs: 180_000,
  keepaliveMs: 30_000, // ping cadence on tab sockets; drop after 2 missed pongs
};

/** The production handoff PATH. A bare-root fragment is dropped by the website
 *  shell for signed-in users (verifier-proven); /playground survives today. */
const PROD_HANDOFF_BASE = `${BRILLIANT_ORIGIN}/playground`;

/** One attribution value for the pairing URL: letters, digits, dot, dash and
 *  underscore only, at most 64 characters (a client names itself, so its name
 *  is never trusted as URL text). Empty when nothing usable is left. */
export function attributionTag(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** The production pairing URL the browser opens: the base, three attribution
 *  params, then the fragment. `utm_source` is always `mcp-helper`,
 *  `utm_medium` the MCP client's own name, `utm_content` the door tag of the
 *  install snippet (`--src <tag>` or BRILLIANT_MCP_SRC); an empty one is left
 *  out. They say where an install came from and carry nothing about the user,
 *  the machine or the design. The port and token stay in the fragment, which
 *  a browser never sends to a server. */
export function handoffUrl(base, { port, token, client, src }) {
  const params = [["utm_source", "mcp-helper"], ["utm_medium", attributionTag(client)], ["utm_content", attributionTag(src)]]
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${params}#bridge=${port}&t=${token}`;
}

function num(envName, fallback) {
  const v = process.env[envName];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Config precedence: explicit opts win over env vars win over DEFAULTS. Env
 *  plumbing lets the spawned `npx` process (which passes no opts) be tuned and,
 *  crucially, kept hermetic in tests (ephemeral ws ports, desktop probe off). */
function resolveConfig(opts) {
  const envPorts = process.env.BRILLIANT_MCP_WS_PORTS;
  const wsPorts =
    opts.wsPorts ||
    (envPorts ? envPorts.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : DEFAULTS.wsPorts);
  return {
    wsPorts: wsPorts.length ? wsPorts : DEFAULTS.wsPorts,
    helloTimeoutMs: opts.helloTimeoutMs ?? num("BRILLIANT_MCP_HELLO_TIMEOUT_MS", DEFAULTS.helloTimeoutMs),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? num("BRILLIANT_MCP_APPROVAL_TIMEOUT_MS", DEFAULTS.approvalTimeoutMs),
    // The shipped tool list a cold discovery is answered from (a function, so
    // a test can run with none).
    toolsSnapshot: opts.toolsSnapshot ?? readToolsSnapshot,
    // The door tag of the install snippet that started this helper.
    src: opts.src ?? process.env.BRILLIANT_MCP_SRC ?? "",
    pairWaitMs: opts.pairWaitMs ?? num("BRILLIANT_MCP_PAIR_WAIT_MS", DEFAULTS.pairWaitMs),
    handoffTimeoutMs: opts.handoffTimeoutMs ?? num("BRILLIANT_MCP_HANDOFF_TIMEOUT_MS", DEFAULTS.handoffTimeoutMs),
    callTimeoutMs: opts.callTimeoutMs ?? num("BRILLIANT_MCP_CALL_TIMEOUT_MS", DEFAULTS.callTimeoutMs),
    fragmentTokenTtlMs: opts.fragmentTokenTtlMs ?? DEFAULTS.fragmentTokenTtlMs,
    keepaliveMs: opts.keepaliveMs ?? num("BRILLIANT_MCP_KEEPALIVE_MS", DEFAULTS.keepaliveMs),
  };
}

/** Start the leader. Binds the fallback ws listener + the /rpc server, probes
 *  for the desktop app, and writes leader.json. Returns a control object. */
export async function startLeader(opts = {}) {
  const cfg = resolveConfig(opts);
  const openUrl = opts.openUrl || defaultOpenUrl;
  const desktopDisabled = process.env.BRILLIANT_MCP_DISABLE_DESKTOP === "1";
  const detectDesktop = opts.detectDesktop || (desktopDisabled ? async () => null : defaultDetectDesktop);
  const token = mintToken(); // follower->leader /rpc auth token
  // The bytes THIS leader is running, stamped into the lease so a peer carrying
  // fresher bytes can tell we are stale and force a handoff. onStepDown lets helper.js re-elect (rejoin as a follower of the
  // newer leader) after we yield.
  const version = opts.version || ownVersion();
  const onStepDown = typeof opts.onStepDown === "function" ? opts.onStepDown : () => {};
  let steppingDown = false;

  // Dev override: a single-value origin gate for a developer driving a localhost
  // tab. BRILLIANT_MCP_DEV_ORIGIN, when set, is a FULL BASE URL used verbatim as
  // the handoff base (+ '#bridge=...'); its ORIGIN (scheme+host, the shape a
  // browser sends in the Origin header) REPLACES the production origin as the
  // single accepted gate value: NOT additive, so the prod origin is then
  // refused. Unset => production origin + /playground handoff, byte-identical.
  const devOrigin = process.env.BRILLIANT_MCP_DEV_ORIGIN;
  let originGate = BRILLIANT_ORIGIN;
  let handoffBase = PROD_HANDOFF_BASE;
  if (devOrigin && devOrigin.length > 0) {
    handoffBase = devOrigin; // full base URL, used verbatim
    try {
      originGate = new URL(devOrigin).origin; // Origin header is scheme+host only
    } catch {
      originGate = devOrigin; // best effort if not a parseable URL
    }
    // Loud + unconditional (bypasses the quiet flag): a dev origin gate is a
    // security-relevant relaxation and must always announce itself.
    process.stderr.write(
      `\n[brilliant-mcp] DEV MODE: accepting origin ${originGate} - never use in production\n\n`,
    );
  }

  /** @type {Map<string, Surface>} connected surfaces, keyed by surface id. */
  const surfaces = new Map();
  /** @type {Map<string, string>} agent session id -> bound surface id. */
  const bindings = new Map();
  const refusals = { badOrigin: 0, badHost: 0, noToken: 0, unknownFrame: 0, count: 0 };
  const fragmentTokens = new Map(); // token -> expiresAt
  // The AGENT's clientInfo.name from the stdio initialize we relay (per session),
  // and the most-recent one: the approval card must name the coding agent, not
  // the tab's project.
  const sessionClients = new Map(); // sessionId -> clientInfo.name
  let lastClientName = null;
  let handoffInFlight = null; // shared promise while a handoff is open
  let handoffServer = null; // lazily-bound ephemeral listener
  let handoffPort = null;

  function refuse(ws, reason, counter) {
    refusals[counter] = (refusals[counter] || 0) + 1;
    refusals.count += 1;
    try {
      ws.send(JSON.stringify({ v: 1, kind: "denied", reason }));
    } catch {
      /* socket already gone */
    }
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  function fragmentTokenValid(t) {
    if (typeof t !== "string" || t.length === 0) return false;
    const exp = fragmentTokens.get(t);
    if (!exp) return false;
    if (Date.now() > exp) {
      fragmentTokens.delete(t);
      return false;
    }
    return true;
  }

  // ---- surface registration ------------------------------------------------

  function registerWebSurface(ws, hello) {
    const id = typeof hello.tabId === "string" && hello.tabId ? hello.tabId : `tab-${mintToken(6)}`;
    const pending = new Map(); // frame id -> {resolve, timer}
    const surface = {
      id,
      kind: "web",
      project: hello.project || null,
      viewOnly: !!hello.viewOnly,
      active: true,
      lastActiveAt: Date.now(),
      connected: true,
      send(payload) {
        return new Promise((resolve, reject) => {
          if (!surface.connected) return reject(new Error("surface disconnected"));
          const fid = mintToken(8);
          const timer = setTimeout(() => {
            pending.delete(fid);
            // A slow tab can APPLY the mutation and still miss this deadline, so
            // the caller must not blindly retry (proven live: a retry on the old
            // "did not reply" text double-created). Say the op may have applied
            // and point at a read tool to check first.
            reject(new Error(
              `the tab did not reply within ${Math.ceil(cfg.callTimeoutMs / 1000)}s; ` +
                "the operation may still have applied in the tab. Verify with a " +
                "read tool (lookup / get_selection) before retrying a mutation."));
          }, cfg.callTimeoutMs);
          pending.set(fid, { resolve, timer });
          try {
            ws.send(JSON.stringify({ v: 1, kind: "mcp", id: fid, payload }));
          } catch (e) {
            clearTimeout(timer);
            pending.delete(fid);
            reject(e);
          }
        });
      },
      terminate() {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      },
    };
    surfaces.set(id, surface);

    // Keepalive: ping every keepaliveMs; any inbound frame proves liveness and
    // resets the miss counter; two consecutive missed pongs drops the surface.
    let missedPongs = 0;
    const keepalive = setInterval(() => {
      if (!surface.connected) return;
      if (missedPongs >= 2) {
        log(`surface ${id} missed 2 keepalive pongs: dropping`);
        try {
          ws.terminate();
        } catch {
          try {
            ws.close();
          } catch {
            /* gone */
          }
        }
        drop();
        return;
      }
      missedPongs += 1;
      try {
        ws.send(JSON.stringify({ v: 1, kind: "ping" }));
      } catch {
        /* gone */
      }
    }, cfg.keepaliveMs);
    if (keepalive.unref) keepalive.unref();

    ws.on("message", (data) => {
      const parsed = parseMessage(String(data));
      if (!parsed.ok) return;
      const frame = parsed.msg;
      if (frame.v !== 1) return;
      missedPongs = 0; // any valid inbound frame proves the socket is alive
      switch (frame.kind) {
        case "mcp-reply": {
          const p = pending.get(frame.id);
          if (!p) return;
          pending.delete(frame.id);
          clearTimeout(p.timer);
          surface.lastActiveAt = Date.now();
          p.resolve(typeof frame.payload === "string" ? frame.payload : "");
          return;
        }
        case "surface": {
          surface.project = frame.project || surface.project;
          if (typeof frame.viewOnly === "boolean") surface.viewOnly = frame.viewOnly;
          if (typeof frame.active === "boolean") surface.active = frame.active;
          surface.lastActiveAt = Date.now();
          return;
        }
        case "ping":
          try {
            ws.send(JSON.stringify({ v: 1, kind: "pong" }));
          } catch {
            /* gone */
          }
          return;
        case "pong":
          return;
        default:
          refusals.unknownFrame += 1; // unknown kinds are ignored + counted
          return;
      }
    });

    const drop = () => {
      surface.connected = false;
      clearInterval(keepalive);
      // Only this socket's own entry: a later socket under the same tabId (a
      // reload, a duplicated tab, a profile-wide id) replaced it and stays live.
      if (surfaces.get(id) === surface) {
        surfaces.delete(id);
        for (const [sess, sid] of bindings) if (sid === id) bindings.delete(sess);
      }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
      }
      pending.clear();
    };
    ws.on("close", drop);
    ws.on("error", drop);
    return surface;
  }

  // ---- the ws connection gate (shared by fallback + handoff listeners) ------

  function handleConnection(ws, req, listenerKind) {
    const origin = req.headers.origin;
    if (origin !== originGate) return refuse(ws, "bad-origin", "badOrigin");
    if (!isLoopbackHost(req.headers.host)) return refuse(ws, "bad-host", "badHost");

    let settled = false;
    const helloTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      refuse(ws, "hello-timeout", "noToken");
    }, cfg.helloTimeoutMs);

    ws.once("message", (data) => {
      if (settled) return;
      const parsed = parseMessage(String(data));
      if (!parsed.ok || parsed.msg.kind !== "hello") {
        settled = true;
        clearTimeout(helloTimer);
        return refuse(ws, "expected-hello", "noToken");
      }
      const hello = parsed.msg;
      clearTimeout(helloTimer); // the hello arrived; the no-hello timer is done

      // ASSOCIATION-SEND LAW (amended envelope): the fragment (handoff) lane
      // honors ONLY the fragment token: an association is never accepted there,
      // since the fragment names an arbitrary port and honoring a secret on it
      // would let a crafted link harvest it. The fallback lane honors ONLY a
      // stored association (or the approval flow below).
      if (listenerKind === "handoff") {
        settled = true;
        if (fragmentTokenValid(hello.token)) return accept(ws, req, hello, { viaFragment: true });
        return refuse(ws, "bad-token", "noToken");
      }

      // Fallback lane: a known association is accepted directly.
      if (typeof hello.association === "string" && isKnownAssociation(hello.association)) {
        settled = true;
        return accept(ws, req, hello, { viaFragment: false });
      }

      // No stored association -> KeePassXC-lite approval, naming the AGENT (its
      // clientInfo.name), never the tab's project.
      const client = clientLabel();
      try {
        ws.send(JSON.stringify({ v: 1, kind: "approval-needed", client }));
      } catch {
        /* gone */
      }
      const approvalTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        refuse(ws, "approval-timeout", "noToken");
      }, cfg.approvalTimeoutMs);
      ws.once("message", (d2) => {
        if (settled) return;
        settled = true;
        clearTimeout(approvalTimer);
        const p2 = parseMessage(String(d2));
        if (!p2.ok || p2.msg.kind !== "approve" || typeof p2.msg.association !== "string") {
          return refuse(ws, "approve-malformed", "noToken");
        }
        addAssociation(p2.msg.association, client);
        accept(ws, req, hello, { viaFragment: false });
      });
    });
  }

  function accept(ws, req, hello, { viaFragment = false } = {}) {
    const acceptedFrame = { v: 1, kind: "accepted" };
    // FRAGMENT PAIRING -> mint + persist a fresh association and hand it back in
    // the accepted frame (amended envelope). The tab persists it so it can
    // re-pair over the FALLBACK lane after a leader restart (fragment ports are
    // ephemeral and die with the leader). Never minted on the association/approval
    // paths (those already have a durable secret).
    if (viaFragment) {
      const minted = mintToken();
      addAssociation(minted, lastClientName);
      acceptedFrame.association = minted;
    }
    try {
      ws.send(JSON.stringify(acceptedFrame));
    } catch {
      /* gone */
    }
    const surface = registerWebSurface(ws, hello);
    refreshToolsCache(surface);
    // A handoff waiter is satisfied by any tab arriving with a valid fragment
    // token (the port it came in on is the ephemeral handoff port).
    if (viaFragment && handoffInFlight) {
      handoffInFlight.resolveSurface(surface);
    }
    log(`surface connected: ${surface.id} (${hello.project ? hello.project.handle : "?"})`);
  }

  /** The name the approval card shows: the AGENT (its stdio initialize
   *  clientInfo.name), never the tab's project. */
  function clientLabel() {
    return lastClientName || "a coding agent";
  }

  // ---- desktop surface -----------------------------------------------------

  function registerDesktopSurface(port) {
    const id = "desktop";
    const surface = {
      id,
      kind: "desktop",
      project: { handle: "desktop", name: "Desktop app", title: "Brilliant (desktop)" },
      viewOnly: false,
      active: false,
      lastActiveAt: Date.now(),
      connected: true,
      async send(payload) {
        // Relay under the CALL budget, never the 1.5s DETECTION probe timeout:
        // a heavy op (cross-canvas instancing off a big master) that SUCCEEDS on
        // the app side used to take longer than the probe budget and surface
        // "desktop probe timeout" while the elements were in fact created, so an
        // agent that retried on it DUPLICATED. This mirrors the web tab's
        // send(), which already waits the full call budget.
        let res;
        try {
          res = await postMcp(port, payload, { timeoutMs: cfg.callTimeoutMs });
        } catch (e) {
          // A call that genuinely outran even the call budget MAY have applied
          // on the desktop app (proven live for the web twin: a retry on a bare
          // "did not reply" text double-created). Say so and point at a read
          // tool, exactly like the web surface, never the raw probe-timeout,
          // which reads like a transient failure and invites a blind retry.
          if (e && e.message === "desktop probe timeout") {
            const busy = new Error(
              `the desktop app did not reply within ${Math.ceil(cfg.callTimeoutMs / 1000)}s; ` +
                "the operation may still have applied. Verify with a read tool " +
                "(lookup / get_selection) before retrying a mutation.");
            busy.desktopBusy = true; // it accepted the call: alive, only slow
            throw busy;
          }
          throw e;
        }
        surface.lastActiveAt = Date.now();
        if (res.status === 202 || !res.text) return "";
        const parsed = parseMaybeSse(res.text);
        return parsed ? JSON.stringify(parsed) : res.text;
      },
    };
    surfaces.set(id, surface);
    return surface;
  }

  /** A desktop relay failure is the one place surface liveness can silently
   *  rot: the desktop surface is registered once at election with
   *  connected:true and nothing ws-level ever flips it (a web tab's socket
   *  close does). Left alone, a session bound to a QUIT desktop app returns
   *  "surface relay failed" forever, even while a live web tab is connected
   *  (a field wedge). On failure:
   *  re-probe the pool. An app that moved ports re-registers under the same
   *  surface id (bound sessions follow it transparently); a dead one flips
   *  connected=false so resolveTarget drops the binding and rebinds the
   *  session on its next call, web tabs first per the outranking rule.
   *
   *  A BUSY DESKTOP IS NOT A DEAD ONE: a
   *  call that outran the budget reached a server that ACCEPTED it, so the app
   *  is alive and only slow. Re-probing then asks the same stalled isolate for
   *  an initialize inside 1.5 s; it failed, the surface flipped, and the
   *  session rebound to a project-less web tab that answered list_projects
   *  with nothing for the rest of the session. A timeout keeps the surface. */
  async function handleDesktopRelayFailure(target, err) {
    if (!target || target.kind !== "desktop") return;
    if (err && err.desktopBusy) return;
    const port = await Promise.resolve()
      .then(() => detectDesktop())
      .catch(() => null);
    if (port) registerDesktopSurface(port);
    else target.connected = false;
  }

  /** THE NO-LAUNCH LAW, part 1: before the helper answers "no
   *  surface" (a local initialize, a pairing tab), it re-probes the desktop
   *  pool. The election probe runs once, so an app launched AFTER this leader
   *  was invisible to it, and every new session's tools/list opened a browser
   *  tab while the app sat right there. A running app is connected to, never
   *  opened over: the helper never opens, launches or activates anything when
   *  the app answers. */
  async function adoptRunningDesktop() {
    const port = await Promise.resolve()
      .then(() => detectDesktop())
      .catch(() => null);
    if (!port) return null;
    log(`desktop app detected on 127.0.0.1:${port}`);
    const surface = registerDesktopSurface(port);
    refreshToolsCache(surface);
    return surface;
  }

  // ---- surface selection + disclosure --------------------------------------

  function connectedSurfaces() {
    return [...surfaces.values()].filter((s) => s.connected);
  }

  /** A web tab with no project open (a brilliant.design page outside the
   *  editor): it addresses nothing, so its list_projects is empty. */
  function isProjectlessTab(s) {
    return s.kind === "web" && !(s.project && (s.project.handle || s.project.name));
  }

  /** Target selection: connected web tabs with a project open outrank the
   *  desktop surface (a live desktop app silently swallowed
   *  writes meant for the tab); a project-less tab ranks BELOW a connected
   *  desktop (it addresses nothing). Among the chosen pool, most-recently-active
   *  wins (tiebreak: active). */
  function mostRecentlyActive() {
    const list = connectedSurfaces();
    const tabs = list.filter((s) => s.kind === "web" && !isProjectlessTab(s));
    const desktops = list.filter((s) => s.kind === "desktop");
    const pool = tabs.length > 0 ? tabs : desktops.length > 0 ? desktops : list;
    if (pool.length === 0) return null;
    return pool.sort((a, b) => {
      if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
      return (b.active ? 1 : 0) - (a.active ? 1 : 0);
    })[0];
  }

  /** Resolve the target surface for a session, binding first-wins on tools/*. */
  function resolveTarget(sessionId, bindNow) {
    const boundId = bindings.get(sessionId);
    if (boundId) {
      const bound = surfaces.get(boundId);
      // A session bound to a project-less tab re-resolves on every call, so it
      // moves the moment an addressable surface connects.
      if (bound && bound.connected && !isProjectlessTab(bound)) return bound;
      bindings.delete(sessionId); // bound tab is gone: fall through to rebind
    }
    const mra = mostRecentlyActive();
    if (mra && bindNow) bindings.set(sessionId, mra.id);
    return mra;
  }

  /** One surface's disclosure entry: includes viewOnly
   *  and surface kind ('web'|'desktop'). */
  function surfaceEntry(s) {
    return { tabId: s.id, project: s.project, active: s.active, viewOnly: s.viewOnly, surface: s.kind };
  }

  /** Build _meta.brilliant for a result routed to `target`. `surface` names the
   *  bound kind explicitly (so 'desktop' is never silent), and every entry
   *  carries viewOnly. */
  function disclosureFor(target) {
    return {
      project: target.project,
      tabId: target.id,
      viewOnly: target.viewOnly,
      surface: target.kind,
      otherTabs: connectedSurfaces()
        .filter((s) => s.id !== target.id)
        .map(surfaceEntry),
    };
  }

  /** Attach _meta.brilliant to a tools/call RESULT reply without touching
   *  content. Errors and non-result replies pass through untouched. */
  function attachDisclosure(reply, target) {
    if (!reply) return reply;
    let parsed;
    try {
      parsed = JSON.parse(reply);
    } catch {
      return reply;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.result) return reply;
    const meta = parsed.result._meta && typeof parsed.result._meta === "object" ? parsed.result._meta : {};
    meta.brilliant = disclosureFor(target);
    parsed.result._meta = meta;
    return JSON.stringify(parsed);
  }

  // ---- fragment handoff ----------------------------------------------------

  function ensureHandoffListener() {
    if (handoffServer) return Promise.resolve(handoffPort);
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      wss.on("connection", (ws, req) => handleConnection(ws, req, "handoff"));
      server.once("error", reject);
      server.listen(0, LOOPBACK, () => {
        handoffServer = { server, wss };
        handoffPort = server.address().port;
        resolve(handoffPort);
      });
    });
  }

  async function triggerHandoff(sessionId) {
    if (handoffInFlight) return handoffInFlight.promise;
    const port = await ensureHandoffListener();
    const t = mintToken();
    fragmentTokens.set(t, Date.now() + cfg.fragmentTokenTtlMs);
    const client = sessionClients.get(sessionId) || lastClientName || "";
    // A dev base is used verbatim: attribution is for production installs.
    const url =
      handoffBase === PROD_HANDOFF_BASE
        ? handoffUrl(handoffBase, { port, token: t, client, src: cfg.src })
        : `${handoffBase}#bridge=${port}&t=${t}`;

    let resolveSurface, rejectHandoff;
    const promise = new Promise((resolve, reject) => {
      resolveSurface = resolve;
      rejectHandoff = reject;
    });
    const timer = setTimeout(() => {
      rejectHandoff(new Error("handoff-timeout"));
    }, cfg.handoffTimeoutMs);
    handoffInFlight = {
      promise,
      resolveSurface: (surface) => {
        clearTimeout(timer);
        handoffInFlight = null;
        resolveSurface(surface);
      },
    };
    promise.catch(() => {}).finally(() => {
      clearTimeout(timer);
      if (handoffInFlight && handoffInFlight.promise === promise) handoffInFlight = null;
    });

    log(`no surface connected: opening ${handoffBase} for pairing (port ${port})`);
    openUrl(url);
    return promise;
  }

  // ---- the dispatch seam (leader's own stdio AND every follower /rpc) -------

  const HANDOFF_HELP =
    "Brilliant is not connected yet, so nothing was done. Open " +
    "https://brilliant.design/playground in Chrome, Edge or Firefox (a tab " +
    "should have just opened), or open the Brilliant desktop app. When the " +
    "browser asks to let brilliant.design reach apps on this device (the local " +
    "network prompt), allow it. Then run this call again.";

  /** The pairing, waited on for at most pairWaitMs. The handoff itself stays
   *  open after that, so a retry meets the tab the user is still approving. */
  function pairWithin(sessionId) {
    const handoff = triggerHandoff(sessionId);
    let timer;
    const cut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("handoff-timeout")), cfg.pairWaitMs);
    });
    return Promise.race([handoff, cut]).finally(() => clearTimeout(timer));
  }

  async function handle(raw, sessionId) {
    const parsed = parseMessage(raw);
    if (!parsed.ok) return rpcError(null, -32700, `Parse error: ${parsed.error}`);
    const msg = parsed.msg;
    const method = msg.method;
    const id = msg.id;

    // Notifications / responses: forward to a surface best-effort, no reply.
    if (isNoReply(msg)) {
      if (typeof method === "string") {
        const target = resolveTarget(sessionId, false);
        if (target) target.send(raw).catch(() => {});
      }
      return "";
    }

    if (method === "ping") return rpcResult(id, {});

    if (method === "initialize") {
      // Capture the AGENT's clientInfo.name (per session + most-recent) from the
      // initialize we relay: followers forward the same payload, so this covers
      // leader and follower sessions alike. It names the approval card.
      const clientName = msg.params && msg.params.clientInfo && msg.params.clientInfo.name;
      if (typeof clientName === "string" && clientName.length > 0) {
        sessionClients.set(sessionId, clientName);
        lastClientName = clientName;
      }
      const target = resolveTarget(sessionId, false) || (await adoptRunningDesktop());
      // No surface: answer locally and fabricate NO disclosure (nothing to
      // disclose). With a surface: relay verbatim and attach the same
      // _meta.brilliant the agent gets on tools/call, so it learns the
      // connected surfaces at session start rather than after its first tool.
      if (!target) return rpcResult(id, localInitializeResult(msg.params));
      let reply;
      try {
        reply = await target.send(raw);
      } catch (e) {
        await handleDesktopRelayFailure(target, e);
        return rpcError(id, -32000, `surface relay failed: ${e.message}`);
      }
      return attachDisclosure(reply, target);
    }

    const isToolsCall = method === "tools/call";
    const isToolsMethod = typeof method === "string" && method.startsWith("tools/");

    // tools/* is the binding trigger. With no surface, a running desktop app is
    // adopted first (never opened over).
    let target = resolveTarget(sessionId, isToolsMethod);
    // A project-less tab is no surface to address: a running desktop app the
    // leader lost (or never saw) is adopted over it.
    const lacksDesktop = !connectedSurfaces().some((s) => s.kind === "desktop");
    if ((!target || (isProjectlessTab(target) && lacksDesktop)) && (await adoptRunningDesktop())) {
      target = resolveTarget(sessionId, isToolsMethod);
    }

    // THE NO-LAUNCH LAW, part 2: every client sends tools/list
    // on its own at session start, so discovery is never the user's ask. Once
    // the helper has seen the tool list, a session start with no surface is
    // answered from the cached list and opens nothing. Only a tools/call (the
    // agent acting) opens the pairing tab, as the local initialize promises.
    // The first-ever discovery (no kept list) is answered from the list this
    // package ships, so a first run, a registry crawler or a reviewer running
    // the package cold gets the tool list instead of a pairing tab and an error.
    if (!target && method === "tools/list") {
      const listed = readToolsCache(version) || cfg.toolsSnapshot();
      if (listed) return rpcResult(id, listed);
    }

    // The handoff trigger when no surface.
    if (!target && isToolsMethod) {
      try {
        target = await pairWithin(sessionId);
        bindings.set(sessionId, target.id); // first-bind-wins on the paired tab
      } catch (e) {
        const text = `${e.message === "handoff-timeout" ? "" : e.message + ": "}${HANDOFF_HELP}`;
        // A call answers as a tool result, the text an agent relays to its
        // user; a JSON-RPC error often reaches the user as a bare failure.
        if (isToolsCall) return rpcResult(id, { content: [{ type: "text", text }], isError: true });
        return rpcError(id, -32000, text);
      }
    }
    if (!target) {
      // A non-tools method with no surface (rare): honest error.
      return rpcError(id, -32000, HANDOFF_HELP);
    }

    let reply;
    try {
      reply = await target.send(raw);
    } catch (e) {
      await handleDesktopRelayFailure(target, e);
      return rpcError(id, -32000, `surface relay failed: ${e.message}`);
    }
    if (isToolsCall) reply = attachDisclosure(reply, target);
    if (method === "tools/list") cacheToolsList(reply);
    return reply;
  }

  /** Keep the last tools/list a surface answered, for the next session's
   *  discovery (THE NO-LAUNCH LAW, part 2). */
  function cacheToolsList(reply) {
    try {
      const parsed = JSON.parse(reply);
      if (parsed && parsed.result) writeToolsCache(parsed.result, version);
    } catch {
      /* not a JSON reply: nothing to keep */
    }
  }

  /** Refresh the cached list on every surface pairing, so the list a later
   *  session start is answered from is the newest surface's. Best effort and
   *  never awaited by the pairing itself. */
  function refreshToolsCache(surface) {
    Promise.resolve()
      .then(() => surface.send(JSON.stringify({ jsonrpc: "2.0", id: "brilliant-mcp-tools-cache", method: "tools/list" })))
      .then((reply) => cacheToolsList(reply))
      .catch(() => {});
  }

  function localInitializeResult(params) {
    const requested = params && params.protocolVersion;
    return {
      protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
      capabilities: { tools: {} },
      // The helper's own package version, never the protocol date.
      serverInfo: { name: "brilliant", version },
      instructions:
        "Brilliant is not connected yet. The tools are listed, and the first tool " +
        "call opens https://brilliant.design/playground in the browser to pair " +
        "(Chrome, Edge or Firefox; allow the local network prompt), unless the " +
        "Brilliant desktop app is running. If a call answers that Brilliant is " +
        "not connected, tell the user what to open and run the call again.",
    };
  }

  // ---- follower /rpc server + the version-handoff /control endpoint --------

  /** Yield leadership to a peer carrying strictly-fresher bytes: clear the lease
   *  and drop the sockets (connected tabs re-pair to the new leader over the
   *  fallback lane), then let helper.js re-elect so THIS process rejoins as a
   *  follower of the new leader. Idempotent. This is how a stale npx-cached
   *  leader is retired the moment any newer client spawns (durability, 6a994404). */
  async function stepDown() {
    if (steppingDown) return;
    steppingDown = true;
    try {
      await close();
    } finally {
      onStepDown();
    }
  }

  function readBody(req, cb) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => cb(body));
  }

  const rpcServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rpc") {
      return readBody(req, async (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("bad body");
        }
        // Token gate. NEVER echo the token back in any response.
        if (parsed.token !== token) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("forbidden");
        }
        const sessionId = req.headers["x-brilliant-session"] || "follower";
        try {
          const reply = await handle(String(parsed.payload ?? ""), String(sessionId));
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(reply);
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(rpcError(null, -32603, `leader dispatch failed: ${e.message}`));
        }
      });
    }
    // /control: a peer whose bytes are strictly NEWER than ours asks us to yield
    // so fresh bytes win. Same token gate as /rpc (a rogue local process cannot
    // unseat the leader). We yield ONLY to a strictly-greater version, so this
    // can never force a downgrade nor wedge equal peers into a re-election loop.
    if (req.method === "POST" && req.url === "/control") {
      return readBody(req, (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("bad body");
        }
        if (parsed.token !== token) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("forbidden");
        }
        const yielding = parsed.op === "step-down" && compareVersions(version, parsed.version) < 0;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        // Flush the verdict FIRST; only then drop our sockets, so the requester
        // reliably learns we yielded before it contends for leadership.
        res.end(JSON.stringify({ ok: yielding, version }), () => {
          if (yielding) {
            log(`stepping down for a newer peer (v${version} -> v${parsed.version})`);
            stepDown();
          }
        });
      });
    }
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  });

  // ---- bring the listeners up ----------------------------------------------

  const rpcPort = await listen(rpcServer, 0);
  const wsPort = await bindFallbackWs(cfg.wsPorts, handleConnection);
  writeLeader({ pid: process.pid, port: wsPort.port, rpcPort, token, version });

  let desktopPort = null;
  try {
    desktopPort = await detectDesktop();
    if (desktopPort) {
      refreshToolsCache(registerDesktopSurface(desktopPort));
      log(`desktop app detected on 127.0.0.1:${desktopPort}`);
    }
  } catch (e) {
    log("desktop detection failed:", e.message);
  }

  async function close() {
    clearLeader(process.pid);
    // Snapshot: terminate() -> ws 'close' -> drop() mutates the surfaces map.
    for (const s of [...surfaces.values()]) {
      s.connected = false;
      if (typeof s.terminate === "function") s.terminate();
    }
    try {
      wsPort.wss.close();
      wsPort.server.close();
    } catch {
      /* best effort */
    }
    if (handoffServer) {
      try {
        handoffServer.wss.close();
        handoffServer.server.close();
      } catch {
        /* best effort */
      }
    }
    await new Promise((r) => rpcServer.close(() => r()));
  }

  return {
    role: "leader",
    handle,
    close,
    token,
    version,
    rpcPort,
    wsPort: wsPort.port,
    handoffPortNow: () => handoffPort,
    desktopPort,
    refusals,
    _stepDown: stepDown,
    // introspection for tests
    surfacesSnapshot: () => connectedSurfaces().map((s) => ({ id: s.id, kind: s.kind, active: s.active })),
    bindingsSnapshot: () => new Map(bindings),
    _triggerHandoff: triggerHandoff,
    _config: cfg,
    _registerDesktop: registerDesktopSurface,
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => resolve(server.address().port));
  });
}

/** Bind the fallback ws listener on the first free port in the published range.
 *  A 0 in the list means an OS-assigned ephemeral port (used by tests).
 *  Exported for the literal occupied-port cell (eaddrinuse_walk.test.js). */
export function bindFallbackWs(ports, onConnection) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) return reject(new Error(`no free ws port in [${ports.join(",")}]`));
      const p = ports[i++];
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      wss.on("connection", (ws, req) => onConnection(ws, req, "fallback"));
      // The ws layer RE-EMITS the underlying server's errors on the
      // WebSocketServer instance; without a listener there, node throws the
      // second emission unhandled and kills the process before the walk can
      // run (the two-helper crash). One handler
      // owns the walk; the wss listener only keeps the re-emission benign.
      wss.on("error", () => {});
      server.once("error", (e) => {
        wss.close();
        server.close();
        if (e.code === "EADDRINUSE") return tryNext();
        reject(e);
      });
      server.listen(p, LOOPBACK, () => {
        resolve({ port: server.address().port, server, wss });
      });
    };
    tryNext();
  });
}
