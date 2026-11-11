// desktop_ports_env.test.js: BRILLIANT_MCP_DESKTOP_PORTS overrides the desktop
// probe pool so a hermetic app instance (ephemeral port, `mcp_endpoint`
// discovery file) is reachable without touching a live session's 3333. The
// default pool stays frozen (prohibitions.test.js pins it).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "./helpers/env.js";
import { startStubDesktop } from "./helpers/stub_desktop.js";

const cleanup = hermeticEnv();
const desktop = await import("../lib/desktop.js");

const stubs = [];
after(async () => {
  for (const s of stubs) await s.close();
  delete process.env.BRILLIANT_MCP_DESKTOP_PORTS;
  cleanup();
});

test("no override: the frozen published pool", () => {
  delete process.env.BRILLIANT_MCP_DESKTOP_PORTS;
  assert.deepEqual(desktop.desktopPorts(), [3333, 3334, 3335]);
});

test("override parses a comma list and drops junk entries", () => {
  process.env.BRILLIANT_MCP_DESKTOP_PORTS = " 45123, nope, -1, 45124 ";
  assert.deepEqual(desktop.desktopPorts(), [45123, 45124]);
  delete process.env.BRILLIANT_MCP_DESKTOP_PORTS;
});

test("garbage-only override falls back to the published pool", () => {
  process.env.BRILLIANT_MCP_DESKTOP_PORTS = "nope,,-5";
  assert.deepEqual(desktop.desktopPorts(), [3333, 3334, 3335]);
  delete process.env.BRILLIANT_MCP_DESKTOP_PORTS;
});

test("detectDesktop honors the override end to end", async () => {
  const stub = await startStubDesktop({ serverName: "brilliant" });
  stubs.push(stub);
  process.env.BRILLIANT_MCP_DESKTOP_PORTS = String(stub.port);
  assert.equal(await desktop.detectDesktop(), stub.port);
  delete process.env.BRILLIANT_MCP_DESKTOP_PORTS;
});
