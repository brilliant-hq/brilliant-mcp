// dev_origin.test.js: BRILLIANT_MCP_DEV_ORIGIN, the single-value dev origin
// gate for a developer driving a localhost tab. The value is a FULL BASE URL:
// its ORIGIN (scheme+host) replaces the production origin as the ONLY accepted
// gate value (a localhost tab is refused when unset; the prod origin is refused
// when set: replacement, never additive), and the value is used verbatim as
// the fragment-handoff base (+ '#bridge=...'). A loud startup banner fires. Own
// file so the env toggle is isolated in its own test process.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, recordingOpener, FAST } from "./helpers/env.js";
import { connectStubTab } from "./helpers/stub_tab.js";

const cleanup = hermeticEnv();
const { startLeader } = await import("../lib/leader.js");
const state = await import("../lib/state.js");

const PROD = "https://brilliant.design";
const DEV_BASE = "http://localhost:8787/acme/demo"; // full base URL (fixture serves /{handle}/{project})
const DEV_ORIGIN = "http://localhost:8787"; // its origin: what a browser sends + the gate value

after(() => cleanup());

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("dev origin override: unset refuses localhost; set is a single-value gate (dev accepted, prod refused), a verbatim handoff base, and a loud banner", async () => {
  state.addAssociation("dev-assoc");

  // ---- Direction A: env UNSET -> production origin only. ----
  delete process.env.BRILLIANT_MCP_DEV_ORIGIN;
  const prodLeader = await startLeader({ ...FAST, openUrl: () => {} });
  try {
    const localhostRefused = await connectStubTab({ port: prodLeader.wsPort, origin: DEV_ORIGIN, association: "dev-assoc" });
    assert.equal(localhostRefused.outcome, "denied");
    assert.equal(localhostRefused.deniedReason, "bad-origin", "unset: a localhost tab is refused");

    const prodAccepted = await connectStubTab({ port: prodLeader.wsPort, origin: PROD, association: "dev-assoc" });
    assert.equal(prodAccepted.outcome, "accepted", "unset: production origin still accepted (byte-identical)");
    prodAccepted.close();
  } finally {
    await prodLeader.close();
  }

  // ---- Direction B: env SET (full base URL) -> its origin is the ONLY gate. ----
  process.env.BRILLIANT_MCP_DEV_ORIGIN = DEV_BASE;
  const banner = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    banner.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  const opener = recordingOpener();
  let devLeader;
  try {
    devLeader = await startLeader({ ...FAST, openUrl: opener.openUrl });
  } finally {
    process.stderr.write = origWrite;
  }
  try {
    // (3) loud startup banner naming the dev ORIGIN (not the full base URL).
    assert.match(banner.join(""), /DEV MODE: accepting origin http:\/\/localhost:8787 - never use in production/);

    // (1) single-value gate: the dev origin is accepted...
    const devAccepted = await connectStubTab({ port: devLeader.wsPort, origin: DEV_ORIGIN, association: "dev-assoc" });
    assert.equal(devAccepted.outcome, "accepted", "set: the exact dev origin is accepted");
    devAccepted.close();

    // ...and the production origin is now REFUSED (replacement, not additive).
    const prodRefused = await connectStubTab({ port: devLeader.wsPort, origin: PROD, association: "dev-assoc" });
    assert.equal(prodRefused.outcome, "denied");
    assert.equal(prodRefused.deniedReason, "bad-origin", "set: production origin refused (single-value gate)");

    // (2) the fragment-handoff URL is the dev base URL used VERBATIM + '#bridge='.
    const pending = devLeader._triggerHandoff().catch(() => {});
    await waitFor(() => opener.opened.length > 0);
    assert.match(opener.opened.at(-1), /^http:\/\/localhost:8787\/acme\/demo#bridge=\d+&t=[0-9a-f]+$/);
    await pending;
  } finally {
    await devLeader.close();
    delete process.env.BRILLIANT_MCP_DEV_ORIGIN;
  }
});
