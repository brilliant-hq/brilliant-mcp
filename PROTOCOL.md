# @brilliant-hq/mcp: protocol reference

The helper is a **dumb router**. MCP JSON-RPC crosses it verbatim inside a tiny
control envelope; the only thing it adds is the `_meta.brilliant` disclosure on
relayed `initialize` and `tools/call` results. All MCP semantics live in one home:
the MCP dispatcher in the web tab, or the desktop app's MCP server.

Three transports meet here:

```
MCP client ── stdio (NDJSON JSON-RPC) ──> helper (leader or follower)
follower   ── POST /rpc (loopback) ──────> leader
leader     ── ws (control envelope) ─────> brilliant.design tab
leader     ── POST /mcp (loopback) ──────> desktop app (3333/3334/3335)
```

## 1. stdio (MCP client ↔ helper)

Newline-delimited JSON-RPC, per the MCP stdio transport. One message per line,
no embedded newlines. A request (has `id` + `method`) gets exactly one reply
line. A notification/response (no `id`) gets **no** line. **stdout carries JSON-RPC
only**: every log goes to stderr.

The helper advertises nothing of its own. `initialize` / `tools/list` /
`tools/call` are relayed to the bound surface verbatim (a relayed `initialize`
result additionally gets the `_meta.brilliant` disclosure, below). Two exceptions
handled locally:

- `ping` → `{"result":{}}` (never needs a surface).
- With **no surface connected**: `initialize` is answered locally (serverInfo
  `brilliant` at the helper's own package version, instructions to open
  brilliant.design or the desktop app). The **first `tools/call`** triggers the
  fragment handoff (below) and waits for the pairing for at most the pair wait
  (8 s, `BRILLIANT_MCP_PAIR_WAIT_MS`), then relays. If no tab paired in that
  time the reply is a tool result with `isError: true` whose text says what to
  open and to run the call again; the handoff stays open for its own window,
  so the retry lands on the tab the user was still approving, and no second
  tab opens meanwhile.
- **The no-launch law**. Every client sends `tools/list` on its
  own at session start, so discovery is never the user's ask. Before answering
  "no surface" the leader re-probes the desktop pool, and a running app is
  connected to, never opened over (the election probe alone missed an app
  launched after the leader). A `tools/list` with no surface is answered from
  `tools-cache.json` (§6), the last list a surface answered, and opens nothing.
  With no kept list (a first run, a registry crawler, a reviewer running the
  package cold) it is answered from `lib/tools_snapshot.json`, the release tool
  list this package ships, and still opens nothing. Only a `tools/call` opens
  the pairing tab. The helper never launches or
  activates the desktop app.

## 2. The ws control envelope (helper ↔ tab): FROZEN v1

All frames are JSON text, `v:1`. Unknown kinds are ignored + counted. This is
the frozen cross-leg contract; the tab side is built against the same document.

```
tab -> helper (on connect):
  {v:1, kind:'hello', role:'tab', token:<string|null>, association:<string|null>,
   tabId:<stable id, survives reconnect>, project:{handle,name,title}, viewOnly:<bool>}
  // ASSOCIATION-SEND LAW: the stored association rides FALLBACK-lane dials ONLY.
  // A fragment dial sends the fragment token and NEVER the association (the
  // fragment names an arbitrary port; sending the secret there could harvest it).
helper -> tab:
  {v:1, kind:'accepted', association:<string|absent>}  // fresh minted association on FRAGMENT pairing
  {v:1, kind:'denied', reason:<string>}           // wrong origin/host/token: close after
  {v:1, kind:'approval-needed', client:<string>}  // client = the AGENT's clientInfo.name, not the project
tab -> helper (after in-app approval):
  {v:1, kind:'approve', association:<tab-generated secret>}   // helper persists it
helper -> tab (tool call):
  {v:1, kind:'mcp', id:<string>, payload:<JSON-RPC message string>}
tab -> helper (reply):
  {v:1, kind:'mcp-reply', id:<same>, payload:<JSON-RPC reply string, '' for notification>}
tab -> helper (state):
  {v:1, kind:'surface', project:{handle,name,title}, active:<bool>, viewOnly:<bool>}
either direction: {v:1, kind:'ping'} / {v:1, kind:'pong'}
```

**Disclosure.** The helper owns the binding table, so it attaches
`_meta.brilliant` to every **relayed `initialize` result** and every
**`tools/call` result** it relays: so the agent learns the connected surfaces at
session start, not only after its first tool call. Shape:

```
_meta.brilliant = {
  project, tabId, viewOnly, surface:'web'|'desktop',        // the bound target
  otherTabs: [{tabId, project, active, viewOnly, surface}]  // every other surface
}
```

`surface` names the bound kind explicitly, so a desktop bind is never silent; every entry carries `viewOnly`. It never alters `content`.
Composition is entirely helper-side (no wire change; the tab never sees
`_meta.brilliant`). When **no surface is connected**, `initialize` is answered
locally and carries **no** `_meta`: the helper never fabricates a disclosure for
surfaces that do not exist.

### Wire gates on the leader (all mandatory)

Evaluated in the ws `connection` handler, in order:

1. **Origin** must be exactly `https://brilliant.design`: else `denied` + close.
   (Dev override: if `BRILLIANT_MCP_DEV_ORIGIN` is set, that exact value
   **replaces** the production origin as the single accepted value: not
   additive, so `https://brilliant.design` is then itself refused: and the
   startup logs a loud stderr banner. Never use in production.)
2. **Host** must be loopback (`127.0.0.1`, `::1`, `localhost`): anti-DNS-rebinding
  : else `denied` + close.
3. A `hello` must arrive within the hello timeout, else `denied` + close.
4. Credential: **lane-specific** (association-send law):
   - **Ephemeral handoff (fragment) lane**: ONLY `hello.token` (the live fragment
     token) is honored: an association is never accepted here. Else
     `denied('bad-token')` + close. On accept the helper **mints a fresh
     association, persists it, and returns it in the `accepted` frame** so the tab
     can re-pair over the fallback lane after a leader restart (fragment ports die
     with the leader).
   - **Fallback range (3363-3365) lane**: ONLY a valid `hello.association` is
     honored; with none the helper sends `approval-needed`: naming the **agent**
     (its `clientInfo.name` from the relayed initialize), never the tab's project -
     and accepts only after a matching `approve` frame, whose `association` secret
     is persisted.

Every refusal is `denied` + close and is **counted** (`badOrigin`, `badHost`,
`noToken`, `unknownFrame`). Every listener binds the `127.0.0.1` literal: never
`0.0.0.0`. The listener bind is the network-level gate; no non-loopback peer can
connect at all.

**Keepalive.** The leader pings each tab socket every 30s; any inbound frame
resets the miss counter; **two consecutive missed pongs drops the surface** (so a
silently-dead socket never lingers as a live surface).

### Fragment handoff (primary pairing)

On the first `tools/*` with no surface (a `tools/list` only when no list is
kept, see the no-launch law in §1): mint a fragment token, bind a fresh ws
listener on an **OS-assigned ephemeral 127.0.0.1 port** (port 0), and open
`<handoffBase>?utm_source=mcp-helper[&utm_medium=<client>][&utm_content=<tag>]#bridge=<port>&t=<token>`
with the platform opener (`open` /
`cmd /c start` / `xdg-open`). `handoffBase` is **`https://brilliant.design/playground`**
by default: the bare-root fragment is dropped by the website shell for signed-in
users (verifier-proven), while `/playground` survives: or the full
`BRILLIANT_MCP_DEV_ORIGIN` value verbatim in dev. The three query params are attribution only (production
base only; a dev base gets none): the source, the MCP client's own
`clientInfo.name`, and the door tag of the install snippet (`--src <tag>` or
`BRILLIANT_MCP_SRC`), each reduced to letters, digits, `.`, `_` and `-`, at most
64 characters. They carry nothing about the user, the machine or the design, and
nothing of the pairing secret. The port is **carried in the
fragment, never treated as permanent protocol** and never persisted. The fragment
never reaches any server.

The **dev origin gate** and the **handoff base** are derived from
`BRILLIANT_MCP_DEV_ORIGIN` (a full base URL): the Origin gate uses its `.origin`
(scheme+host, the shape a browser sends), the handoff uses the whole value
verbatim.

## 3. Follower → leader `/rpc` (loopback HTTP)

First helper instance becomes **leader** (owns the ws socket, the `/rpc` server,
the surface + binding tables). Every later instance is a **follower** and
forwards each JSON-RPC message to the leader, streaming the reply back over its
own stdio.

```
POST http://127.0.0.1:<rpcPort>/rpc
  headers: X-Brilliant-Session: <agent session id>   // transport-only; frozen body unchanged
  body:    {token:<leader token from the state dir>, payload:<JSON-RPC string>}
  ->       <JSON-RPC reply string>   ('' for a notification)
```

- The **frozen `/rpc` body is `{token, payload}`** (per the envelope doc). The
  agent-session id rides an `X-Brilliant-Session` **header** (a transport detail
  added by this leg, so the frozen body stays byte-exact) so the leader binds
  each agent session independently. Absent the header the leader uses the
  literal `follower`.
- Wrong token → **403** (`EBADTOKEN`); the real token is never echoed in any
  response. `/rpc` serves nothing on GET (**404**). The token is never obtainable
  from any local endpoint.
- Leadership reassigns on leader exit: a follower whose forward fails re-reads
  the lease, and if it is stale (missing, or its pid is dead) contends for the
  single-writer election lock and takes over; otherwise it follows the new
  leader. Bounded retries.

### Version handoff: fresh bytes always win

Every MCP client spawns its own `npx -y @brilliant-hq/mcp`, and the first to run
becomes the leader for weeks, pinning **whatever version its npx cache held at
spawn**. A stale leader therefore serves old bytes (a fixed bug included) until
its process dies. The durability contract closes that trap:

- The leader stamps its own running **`version`** into `leader.json` (below).
- On election a helper compares the sitting leader's stamped version to **its
  own**. A leader that is **as fresh or fresher** is followed normally. A leader
  running **strictly older** bytes (or an **unstamped** lease, which predates
  this contract) is **refused**: the fresh helper forces a handoff rather than
  quietly following stale bytes.
- The handoff is graceful. The fresh helper asks the sitting leader to yield over
  the loopback **`/control`** channel:

  ```
  POST http://127.0.0.1:<rpcPort>/control
    body: {token:<leader token>, op:'step-down', version:<requester version>}
    ->    {ok:<bool>, version:<leader's own version>}
  ```

  Same token gate as `/rpc` (a rogue local process cannot unseat the leader; wrong
  token → **403**, GET/other → **404**). The leader yields **only** to a version
  **strictly greater** than its own, so `/control` can never force a downgrade,
  nor wedge two equal peers into a re-election loop. On yielding it clears its
  lease and drops its sockets (connected tabs re-pair to the new leader over the
  fallback lane), then rejoins as a **follower** of the new leader on its next
  dispatch. The requester takes over under the election lock. A leader that
  cannot yield gracefully (unreachable, or pre-`/control`) is superseded anyway:
  the fresh helper takes the lease so new clients discover the fresh bytes.

Net effect: the moment **any** newer client spawns, the whole machine converges
on the newest bytes; a stale npx-cached leader can no longer silently ship a
fixed bug.

## 4. Desktop proxy (leader ↔ desktop app)

The leader probes the published loopback pool **3333/3334/3335** with an MCP
`initialize` and accepts a surface only when the reply's `serverInfo.name` is
`brilliant`. (Spec said "GET /mcp handshake"; a bare GET on the desktop's
streamable-HTTP transport yields no identity: identity lives in the
`initialize` reply, so detection uses that POST. Still loopback-only, still a
handshake. Reported as a friction, not silently rerouted.) A streamable-HTTP
reply may be raw JSON or an SSE `data:` frame; both are parsed. MCP is relayed to
desktop by POSTing the JSON-RPC payload to `/mcp`. Desktop is a surface like a
tab, id `desktop`; its `tools/call` results also get `_meta.brilliant`.

**Heavy batches ride the CALL budget, not the 1.5s detection probe.** The relay
waits `callTimeoutMs` (default 120s) for the app to answer a `tools/call`, so a
heavy op that SUCCEEDS but runs long (a 40-command `execute_commands`, a big
`create_html` the app converts synchronously) relays cleanly rather than
surfacing the bare `desktop probe timeout`; the 1.5s budget belongs to
*detection* only. On a genuine call-budget overrun the reply says the op **may
have applied** and to verify with a read tool before retrying (never a bare
probe-timeout that reads transient and invites a double-creating retry). The
helper is a dumb router and does not parse tool arguments, so any hard
**batch-size ceiling lives in the surface** (the tab's MCP dispatcher / the
desktop MCP server), never here.

## 5. Multi-surface binding

`init` builds the surface table (web tabs via `hello`/`surface` frames + desktop
if detected). Session binding: **first bind wins per agent session**: a session
binds on its first `tools/*` and stays there. **Connected web tabs with a project
open outrank the desktop surface** (a live desktop app silently
swallowed writes meant for the tab); the desktop surface is selectable when no
such tab is connected. **A project-less tab** (a brilliant.design page outside the
editor, `hello.project` with no handle and no name) addresses nothing, so it ranks
below a connected desktop, a session bound to one re-resolves on every call, and a
running desktop app the leader lost is adopted over it. Within the chosen pool an
unbound caller tiebreaks to the **most-recently-active** surface (recency, then
`active`). If a bound surface disconnects, the session rebinds on its next call.

**A busy desktop is not a dead one** (a field report: a stalled app
timed one call out, the 1.5 s re-probe timed out against the same stall, the
surface flipped and the session sat on a project-less tab answering
`{"projects":[]}` for an hour). A relay that TIMED OUT reached a server that
accepted the call, so the desktop surface stays connected; only a refused or
reset connection re-probes and may flip it. Cell:
`test/busy_desktop_keeps_its_sessions.test.js`.

## 6. State dir

`~/.config/brilliant/mcp-helper/` (override with `BRILLIANT_MCP_STATE_DIR`).

- `leader.json` `{pid, port, rpcPort, token, version}`, mode **0600**. `port` is
  the discoverable fallback ws port; `rpcPort` is the follower `/rpc` port;
  `token` is the follower-auth token; `pid` drives stale-lease detection;
  `version` is the leader's own running version, so a peer carrying fresher bytes
  can tell it is stale and force a handoff (Version handoff, §3). The ephemeral
  handoff port is **never** written here. **The tab never reads this file** -
  fragment or association only.
- `tools-cache.json` `{version, tools}`, mode 0600. The last `tools/list` result
  a surface answered, refreshed on every pairing and on every relayed
  `tools/list`, and served only to a helper of the same `version`. Tool schemas
  only, never a secret.
- `associations.json` `{associations:[{association, client, addedAt}]}`: mode
  0600. Approved fallback-range helper identities (KeePassXC-lite), persisted on
  `approve`.
- `election.lock`: single-writer O_EXCL election lock; a lock whose owner pid is
  dead (or older than its TTL) is reclaimed.

## Env knobs (used by the spawned process and tests)

`BRILLIANT_MCP_STATE_DIR`, `BRILLIANT_MCP_WS_PORTS` (comma list; `0` = ephemeral),
`BRILLIANT_MCP_DISABLE_DESKTOP=1`, `BRILLIANT_MCP_DESKTOP_PORTS` (comma list;
overrides the desktop probe pool, e.g. a hermetic app instance's ephemeral port
from its `mcp_endpoint` discovery file; loopback-only regardless),
`BRILLIANT_MCP_HELLO_TIMEOUT_MS`,
`BRILLIANT_MCP_APPROVAL_TIMEOUT_MS`, `BRILLIANT_MCP_HANDOFF_TIMEOUT_MS`,
`BRILLIANT_MCP_CALL_TIMEOUT_MS`, `BRILLIANT_MCP_KEEPALIVE_MS` (tab ping cadence,
default 30000), `BRILLIANT_MCP_OPENER` (opener override), `BRILLIANT_MCP_QUIET=1`,
`BRILLIANT_MCP_DEV_ORIGIN` (dev-only: a FULL BASE URL: its `.origin` replaces the
single accepted gate value and its whole value is the handoff base; loud banner;
never use in production).
