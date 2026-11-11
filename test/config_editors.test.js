// config_editors.test.js: the JS text-surgery editors must behave EXACTLY like
// the desktop app's own config editors: merge-never-clobber, exact-inverse
// remove (byte-stability on foreign-carrying configs), and comment preservation
// for JSONC.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertJsonMember,
  removeJsonMember,
  readJsonMember,
  upsertTomlSection,
  removeTomlSection,
  readTomlSection,
} from "../lib/config_editors.js";

const ENTRY = { command: "npx", args: ["-y", "@brilliant-hq/mcp"] };

test("JSON: enable into empty creates the container + member", () => {
  const out = upsertJsonMember("", {
    containerPath: ["mcpServers"],
    memberKey: "brilliant",
    memberValue: ENTRY,
    jsonc: false,
  });
  assert.match(out, /"mcpServers"/);
  assert.match(out, /"brilliant"/);
  assert.deepEqual(
    readJsonMember(out, { containerPath: ["mcpServers"], memberKey: "brilliant", jsonc: false }),
    ENTRY,
  );
});

test("JSON: merge preserves foreign servers AND unknown top-level keys", () => {
  const src =
    "{\n" +
    '  "$schema": "https://example.com/s.json",\n' +
    '  "mcpServers": {\n' +
    '    "other": { "command": "foo", "args": ["a"] }\n' +
    "  },\n" +
    '  "unknownKey": 42\n' +
    "}\n";
  const out = upsertJsonMember(src, {
    containerPath: ["mcpServers"],
    memberKey: "brilliant",
    memberValue: ENTRY,
    jsonc: false,
  });
  assert.deepEqual(
    readJsonMember(out, { containerPath: ["mcpServers"], memberKey: "other", jsonc: false }),
    { command: "foo", args: ["a"] },
  );
  assert.match(out, /"\$schema"/);
  assert.match(out, /"unknownKey": 42/);
  assert.deepEqual(
    readJsonMember(out, { containerPath: ["mcpServers"], memberKey: "brilliant", jsonc: false }),
    ENTRY,
  );
});

test("JSON: byte-stability: enable then disable on foreign content restores bytes", () => {
  const src =
    "{\n" +
    '  "mcpServers": {\n' +
    '    "other": { "command": "foo", "args": ["a", "b"] }\n' +
    "  }\n" +
    "}\n";
  const enabled = upsertJsonMember(src, {
    containerPath: ["mcpServers"],
    memberKey: "brilliant",
    memberValue: ENTRY,
    jsonc: false,
  });
  const disabled = removeJsonMember(enabled, {
    containerPath: ["mcpServers"],
    memberKey: "brilliant",
    jsonc: false,
  });
  assert.equal(disabled, src);
});

test("JSON: disable on empty container collapses container we created", () => {
  const enabled = upsertJsonMember("{}", {
    containerPath: ["mcp", "servers"],
    memberKey: "brilliant",
    memberValue: ENTRY,
    jsonc: false,
  });
  assert.deepEqual(
    readJsonMember(enabled, { containerPath: ["mcp", "servers"], memberKey: "brilliant", jsonc: false }),
    ENTRY,
  );
  const disabled = removeJsonMember(enabled, {
    containerPath: ["mcp", "servers"],
    memberKey: "brilliant",
    jsonc: false,
  });
  // The whole mcp.servers scaffold we created collapses away.
  assert.equal(disabled.trim(), "{}");
});

test("JSONC: comments survive an enable + a foreign server round-trips", () => {
  const src =
    "{\n" +
    "  // user comment\n" +
    '  "servers": {\n' +
    "    /* keep me */\n" +
    '    "other": { "type": "http", "url": "http://x" }\n' +
    "  }\n" +
    "}\n";
  const out = upsertJsonMember(src, {
    containerPath: ["servers"],
    memberKey: "brilliant",
    memberValue: ENTRY,
    jsonc: true,
  });
  assert.match(out, /\/\/ user comment/);
  assert.match(out, /\/\* keep me \*\//);
  assert.deepEqual(
    readJsonMember(out, { containerPath: ["servers"], memberKey: "other", jsonc: true }),
    { type: "http", url: "http://x" },
  );
  // Byte-stability with comments present.
  const back = removeJsonMember(out, { containerPath: ["servers"], memberKey: "brilliant", jsonc: true });
  assert.equal(back, src);
});

test("TOML: upsert appends a section with command/args, read round-trips", () => {
  const out = upsertTomlSection("", {
    table: "mcp_servers",
    name: "brilliant",
    entries: ENTRY,
  });
  assert.match(out, /\[mcp_servers\.brilliant\]/);
  assert.match(out, /command = "npx"/);
  assert.match(out, /args = \["-y", "@brilliant-hq\/mcp"\]/);
  assert.deepEqual(readTomlSection(out, { table: "mcp_servers", name: "brilliant" }), ENTRY);
});

test("TOML: merge preserves foreign sections + comments", () => {
  const src =
    "# my config\n" +
    "[model]\n" +
    'name = "gpt"\n' +
    "\n" +
    "[mcp_servers.other]\n" +
    'command = "foo"\n';
  const out = upsertTomlSection(src, { table: "mcp_servers", name: "brilliant", entries: ENTRY });
  assert.match(out, /# my config/);
  assert.match(out, /\[model\]/);
  assert.match(out, /\[mcp_servers\.other\]/);
  assert.match(out, /\[mcp_servers\.brilliant\]/);
  assert.deepEqual(readTomlSection(out, { table: "mcp_servers", name: "brilliant" }), ENTRY);
});

test("TOML: remove takes only our section, foreign section intact", () => {
  const src =
    "[mcp_servers.other]\n" +
    'command = "foo"\n' +
    "\n" +
    "[mcp_servers.brilliant]\n" +
    'command = "npx"\n' +
    'args = ["-y", "@brilliant-hq/mcp"]\n';
  const out = removeTomlSection(src, { table: "mcp_servers", name: "brilliant" });
  assert.doesNotMatch(out, /\[mcp_servers\.brilliant\]/);
  assert.match(out, /\[mcp_servers\.other\]/);
});
