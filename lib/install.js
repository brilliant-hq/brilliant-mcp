// install.js: the `npx @brilliant-hq/mcp install <client>` subcommand.
//
// Merges the @brilliant-hq/mcp STDIO server into a coding tool's on-disk MCP
// config, reading the per-client facts from the ONE canonical home,
// clients.json (shipped in this package). Same merge law as the desktop app's
// MCP Connections toggles (config_editors.js is a faithful port of
// the app's editors):
//   - MERGE, never clobber foreign servers/keys.
//   - Comment-preserving for JSONC (VS Code, Zed, OpenCode).
//   - Exact-inverse remove: install then remove on a foreign-carrying config
//     restores the original bytes.
//   - Atomic write (temp + rename): a torn write to ANOTHER app's config would
//     destroy the user's foreign servers, not just our entry.
//
// Two surfaces per client live in clients.json: desktop.urlEntry (the desktop
// app's HTTP-URL server, written by the Dart settings toggles) and stdio.entry
// (this installer's `npx -y @brilliant-hq/mcp` command entry). This file writes
// ONLY the stdio entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  upsertJsonMember,
  removeJsonMember,
  readJsonMember,
  upsertTomlSection,
  removeTomlSection,
  readTomlSection,
} from "./config_editors.js";

/** The server key under which Brilliant registers in every client config. */
export const SERVER_KEY = "brilliant";

/** Load the canonical client table shipped alongside this package. */
export function loadClients() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", "clients.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** process.platform -> the os key used in clients.json configPath. */
export function osKey(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/** Resolve a client's config path for the given OS + home/appData roots. */
export function resolveConfigPath(client, { os: osk, home, appData }) {
  const spec = client.configPath[osk];
  if (!spec) throw new Error(`no config path for ${client.id} on ${osk}`);
  const base = spec.base === "appData" ? appData : home;
  return path.join(base, ...spec.segments);
}

/** Wrap the stdio launcher as `cmd /c <launcher>` for Windows, where a bare
 *  `npx` (npx.cmd) is not directly spawnable by most MCP clients. Preserves
 *  key order and handles all three launcher shapes:
 *    {command:"npx", args:[...]}            (Cursor, Gemini, Claude Desktop, …)
 *    {type:"stdio", command:"npx", args:[]} (Claude Code)
 *    {type:"local", command:["npx", ...]}   (OpenCode: command is an array)
 */
export function wrapCmdForWindows(entry) {
  const e = { ...entry };
  if (Array.isArray(e.command)) {
    e.command = ["cmd", "/c", ...e.command];
  } else if (typeof e.command === "string") {
    const oldArgs = Array.isArray(e.args) ? e.args : [];
    e.command = "cmd";
    e.args = ["/c", entry.command, ...oldArgs];
  }
  return e;
}

/** The stdio entry to write for a client, Windows-wrapped when applicable. */
export function stdioEntryFor(client, osk) {
  let entry = client.stdio.entry;
  if (osk === "windows" && client.cmdWrap) entry = wrapCmdForWindows(entry);
  return entry;
}

function appDataRoot(home) {
  return process.env.APPDATA || path.join(home, "AppData", "Roaming");
}

/** Deep structural equality for decoded JSON/TOML values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Atomic write: temp file in the same dir + rename. Creates parent dirs. */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Install the @brilliant-hq/mcp stdio server into `clientId`'s config.
 * opts: { os, home, appData, dryRun, clients }.
 * Returns { ok, clientId, configPath, entry, format, action, error, known }.
 *   action: 'wrote' | 'unchanged' | 'would-write' (dryRun).
 */
export function installClient(clientId, opts = {}) {
  const table = opts.clients || loadClients();
  const client = table.clients.find((c) => c.id === clientId);
  if (!client) {
    return {
      ok: false,
      error: `unknown client: ${clientId}`,
      known: table.clients.map((c) => c.id),
    };
  }
  if (!client.stdio || client.stdio.supported === false) {
    return { ok: false, error: `${clientId} has no stdio entry` };
  }

  const osk = opts.os || osKey();
  const home = opts.home || os.homedir();
  const appData = opts.appData || appDataRoot(home);
  const configPath = resolveConfigPath(client, { os: osk, home, appData });
  const entry = stdioEntryFor(client, osk);

  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  let updated;
  let current;
  if (client.format === "toml") {
    current = readTomlSection(existing, {
      table: client.tomlTable,
      name: SERVER_KEY,
    });
    updated = upsertTomlSection(existing, {
      table: client.tomlTable,
      name: SERVER_KEY,
      entries: entry,
    });
  } else {
    const jsonc = client.format === "jsonc";
    current = readJsonMember(existing, {
      containerPath: client.container,
      memberKey: SERVER_KEY,
      jsonc,
    });
    updated = upsertJsonMember(existing, {
      containerPath: client.container,
      memberKey: SERVER_KEY,
      memberValue: entry,
      jsonc,
    });
  }

  const alreadyConfigured = current != null && deepEqual(current, entry);

  if (alreadyConfigured) {
    return { ok: true, clientId, configPath, entry, format: client.format, action: "unchanged" };
  }
  if (opts.dryRun) {
    return { ok: true, clientId, configPath, entry, format: client.format, action: "would-write", preview: updated };
  }
  atomicWrite(configPath, updated);
  return { ok: true, clientId, configPath, entry, format: client.format, action: "wrote" };
}

/**
 * Remove the @brilliant-hq/mcp stdio server from `clientId`'s config (exact
 * inverse of installClient). Same opts. action: 'removed' | 'absent'.
 */
export function removeClient(clientId, opts = {}) {
  const table = opts.clients || loadClients();
  const client = table.clients.find((c) => c.id === clientId);
  if (!client) {
    return { ok: false, error: `unknown client: ${clientId}`, known: table.clients.map((c) => c.id) };
  }
  const osk = opts.os || osKey();
  const home = opts.home || os.homedir();
  const appData = opts.appData || appDataRoot(home);
  const configPath = resolveConfigPath(client, { os: osk, home, appData });
  if (!fs.existsSync(configPath)) {
    return { ok: true, clientId, configPath, action: "absent" };
  }
  const existing = fs.readFileSync(configPath, "utf8");
  const updated =
    client.format === "toml"
      ? removeTomlSection(existing, { table: client.tomlTable, name: SERVER_KEY })
      : removeJsonMember(existing, {
          containerPath: client.container,
          memberKey: SERVER_KEY,
          jsonc: client.format === "jsonc",
        });
  if (updated === existing) {
    return { ok: true, clientId, configPath, action: "absent" };
  }
  if (opts.dryRun) {
    return { ok: true, clientId, configPath, action: "would-remove", preview: updated };
  }
  atomicWrite(configPath, updated);
  return { ok: true, clientId, configPath, action: "removed" };
}

/** The ids the installer can configure (stdio-supported), in display order. */
export function installableClientIds(table = loadClients()) {
  return table.clients
    .filter((c) => c.stdio && c.stdio.supported !== false)
    .map((c) => c.id);
}
