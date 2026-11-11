// install.test.js: `npx @brilliant-hq/mcp install <client>` end to end, per
// config format, against a temp HOME. Proves: the stdio entry lands in the
// right file/container/shape; foreign servers + comments survive; install is
// idempotent; remove is the exact inverse; Claude Desktop FLIPS to supported
// for stdio; and Windows wraps the launcher as `cmd /c`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installClient,
  removeClient,
  loadClients,
  resolveConfigPath,
  installableClientIds,
} from "../lib/install.js";
import { readJsonMember, readTomlSection } from "../lib/config_editors.js";

const TABLE = loadClients();
const client = (id) => TABLE.clients.find((c) => c.id === id);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-"));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function read(p) {
  return fs.readFileSync(p, "utf8");
}
function jsonEntry(file, containerPath, jsonc) {
  return readJsonMember(read(file), { containerPath, memberKey: "brilliant", jsonc });
}

test("cursor (JSON): install into empty creates the file with the stdio entry", () => {
  const home = tmpHome();
  try {
    const res = installClient("cursor", { clients: TABLE, os: "macos", home });
    assert.equal(res.ok, true);
    assert.equal(res.action, "wrote");
    assert.equal(res.configPath, path.join(home, ".cursor", "mcp.json"));
    assert.deepEqual(jsonEntry(res.configPath, ["mcpServers"], false), {
      command: "npx",
      args: ["-y", "@brilliant-hq/mcp"],
    });
  } finally {
    rm(home);
  }
});

test("cursor: merge preserves a foreign server; remove is the exact inverse", () => {
  const home = tmpHome();
  try {
    const file = path.join(home, ".cursor", "mcp.json");
    const src =
      "{\n" +
      '  "mcpServers": {\n' +
      '    "other": { "command": "foo", "args": ["a", "b"] }\n' +
      "  }\n" +
      "}\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);

    installClient("cursor", { clients: TABLE, os: "macos", home });
    assert.deepEqual(jsonEntry(file, ["mcpServers"], false), {
      command: "npx",
      args: ["-y", "@brilliant-hq/mcp"],
    });
    // Foreign server untouched.
    assert.deepEqual(readJsonMember(read(file), { containerPath: ["mcpServers"], memberKey: "other", jsonc: false }), {
      command: "foo",
      args: ["a", "b"],
    });

    const rem = removeClient("cursor", { clients: TABLE, os: "macos", home });
    assert.equal(rem.action, "removed");
    assert.equal(read(file), src, "remove restores the original bytes");
  } finally {
    rm(home);
  }
});

test("cursor: a second install is a no-op (idempotent)", () => {
  const home = tmpHome();
  try {
    installClient("cursor", { clients: TABLE, os: "macos", home });
    const again = installClient("cursor", { clients: TABLE, os: "macos", home });
    assert.equal(again.action, "unchanged");
  } finally {
    rm(home);
  }
});

test("vscode (JSONC): container is `servers`, comments + foreign survive, remove restores bytes", () => {
  const home = tmpHome();
  try {
    const file = resolveConfigPath(client("vscode"), { os: "macos", home });
    assert.ok(file.endsWith(path.join("Application Support", "Code", "User", "mcp.json")));
    const src =
      "{\n" +
      "  // my servers\n" +
      '  "servers": {\n' +
      '    "other": { "type": "http", "url": "http://x" }\n' +
      "  }\n" +
      "}\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);

    installClient("vscode", { clients: TABLE, os: "macos", home });
    const txt = read(file);
    assert.match(txt, /\/\/ my servers/);
    assert.deepEqual(jsonEntry(file, ["servers"], true), {
      command: "npx",
      args: ["-y", "@brilliant-hq/mcp"],
    });
    assert.deepEqual(readJsonMember(txt, { containerPath: ["servers"], memberKey: "other", jsonc: true }), {
      type: "http",
      url: "http://x",
    });

    removeClient("vscode", { clients: TABLE, os: "macos", home });
    assert.equal(read(file), src, "JSONC remove restores original bytes");
  } finally {
    rm(home);
  }
});

test("vscode: Windows config path lives under %APPDATA%", () => {
  const home = tmpHome();
  try {
    const appData = path.join(home, "AppData", "Roaming");
    const file = resolveConfigPath(client("vscode"), { os: "windows", home, appData });
    assert.equal(file, path.join(appData, "Code", "User", "mcp.json"));
  } finally {
    rm(home);
  }
});

test("opencode (JSONC): stdio entry is {type:local, command:[array], enabled}", () => {
  const home = tmpHome();
  try {
    const res = installClient("opencode", { clients: TABLE, os: "macos", home });
    assert.equal(res.action, "wrote");
    assert.deepEqual(jsonEntry(res.configPath, ["mcp"], true), {
      type: "local",
      command: ["npx", "-y", "@brilliant-hq/mcp"],
      enabled: true,
    });
  } finally {
    rm(home);
  }
});

test("codex (TOML): section written with command/args; foreign section + comment survive; remove restores", () => {
  const home = tmpHome();
  try {
    const file = path.join(home, ".codex", "config.toml");
    const src = "# my config\n[mcp_servers.other]\ncommand = \"foo\"\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);

    installClient("codex", { clients: TABLE, os: "macos", home });
    const txt = read(file);
    assert.match(txt, /# my config/);
    assert.match(txt, /\[mcp_servers\.other\]/);
    assert.deepEqual(readTomlSection(txt, { table: "mcp_servers", name: "brilliant" }), {
      command: "npx",
      args: ["-y", "@brilliant-hq/mcp"],
    });

    removeClient("codex", { clients: TABLE, os: "macos", home });
    const back = read(file);
    assert.doesNotMatch(back, /\[mcp_servers\.brilliant\]/);
    assert.match(back, /\[mcp_servers\.other\]/);
  } finally {
    rm(home);
  }
});

test("claude-desktop FLIPS to supported for stdio (installable even though the desktop URL toggle is not)", () => {
  // The desktop URL surface marks claude-desktop unsupported (stdio-only
  // config). The stdio INSTALLER supports it: the spec's flip.
  assert.equal(client("claude-desktop").desktop.supported, false);
  assert.ok(installableClientIds(TABLE).includes("claude-desktop"));

  const home = tmpHome();
  try {
    const res = installClient("claude-desktop", { clients: TABLE, os: "macos", home });
    assert.equal(res.ok, true);
    assert.equal(res.action, "wrote");
    assert.ok(res.configPath.endsWith(path.join("Claude", "claude_desktop_config.json")));
    assert.deepEqual(jsonEntry(res.configPath, ["mcpServers"], false), {
      command: "npx",
      args: ["-y", "@brilliant-hq/mcp"],
    });
  } finally {
    rm(home);
  }
});

test("Windows: cursor wraps the launcher as cmd /c", () => {
  const home = tmpHome();
  try {
    const appData = path.join(home, "AppData", "Roaming");
    const res = installClient("cursor", { clients: TABLE, os: "windows", home, appData });
    assert.deepEqual(jsonEntry(res.configPath, ["mcpServers"], false), {
      command: "cmd",
      args: ["/c", "npx", "-y", "@brilliant-hq/mcp"],
    });
  } finally {
    rm(home);
  }
});

test("Windows: claude-code preserves type:stdio while wrapping the launcher", () => {
  const home = tmpHome();
  try {
    const appData = path.join(home, "AppData", "Roaming");
    const res = installClient("claude-code", { clients: TABLE, os: "windows", home, appData });
    assert.deepEqual(jsonEntry(res.configPath, ["mcpServers"], false), {
      type: "stdio",
      command: "cmd",
      args: ["/c", "npx", "-y", "@brilliant-hq/mcp"],
    });
  } finally {
    rm(home);
  }
});

test("Windows: opencode wraps the command ARRAY as [cmd, /c, ...]", () => {
  const home = tmpHome();
  try {
    const appData = path.join(home, "AppData", "Roaming");
    const res = installClient("opencode", { clients: TABLE, os: "windows", home, appData });
    assert.deepEqual(jsonEntry(res.configPath, ["mcp"], true), {
      type: "local",
      command: ["cmd", "/c", "npx", "-y", "@brilliant-hq/mcp"],
      enabled: true,
    });
  } finally {
    rm(home);
  }
});

test("muse is a desktop-toggle client only: the installer refuses it and writes nothing", () => {
  // The JS writer lacks Muse's two laws (schema_version kept, legacy
  // mcp_servers renamed), and `muse mcp` has no add subcommand.
  assert.equal(client("muse").desktop.supported, true);
  assert.ok(!installableClientIds(TABLE).includes("muse"));
  const home = tmpHome();
  try {
    const res = installClient("muse", { clients: TABLE, os: "macos", home });
    assert.equal(res.ok, false);
    assert.equal(fs.existsSync(path.join(home, ".config", "muse")), false);
  } finally {
    rm(home);
  }
});

test("unknown client is a clean error listing the known ids", () => {
  const res = installClient("nope", { clients: TABLE, os: "macos", home: tmpHome() });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown client/);
  assert.ok(res.known.includes("cursor"));
});

test("dry-run previews without writing", () => {
  const home = tmpHome();
  try {
    const res = installClient("cursor", { clients: TABLE, os: "macos", home, dryRun: true });
    assert.equal(res.action, "would-write");
    assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
  } finally {
    rm(home);
  }
});
