// package_metadata.test.js: what a registry, a directory crawler and npm read
// off this package before anyone runs it. A listing that points at a missing
// repo, an unlicensed package or a server.json naming another version is
// refused or scored down, so the fields are pinned at the seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const server = JSON.parse(read("server.json"));

test("npm metadata: licence, repository, homepage, bugs and keywords are set", () => {
  assert.equal(pkg.license, "Apache-2.0");
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(pkg.repository.url, "git+https://github.com/brilliant-hq/brilliant-mcp.git");
  assert.equal(pkg.bugs.url, "https://github.com/brilliant-hq/brilliant-mcp/issues");
  assert.match(pkg.homepage, /^https:\/\/brilliant\.design\//);
  for (const k of ["mcp", "mcp-server", "model-context-protocol", "design"]) assert.ok(pkg.keywords.includes(k), `keyword ${k}`);
  assert.equal(pkg.private, false);
});

test("everything the package needs at run time ships", () => {
  for (const f of ["bin/", "lib/", "clients.json", "LICENSE"]) assert.ok(pkg.files.includes(f), `${f} is in files`);
  assert.ok(fs.existsSync(new URL("../lib/tools_snapshot.json", import.meta.url)), "the cold tools/list list ships under lib/");
});

test("server.json names this package at this version (the registry verifies mcpName against npm)", () => {
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.packages[0].transport.type, "stdio");
});

test("the Claude Code plugin pins exactly this version (a directory refuses an unpinned npx launcher)", () => {
  // The plugin sits beside this package in the source tree and under plugin/ in the public repo.
  const beside = new URL("../../", import.meta.url);
  const siblings = fs.readdirSync(beside, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => new URL(`${e.name}/`, beside));
  const found = [new URL("../plugin/", import.meta.url), ...siblings]
    .filter((dir) => fs.existsSync(new URL(".claude-plugin/plugin.json", dir)))
    .map((dir) => new URL(".mcp.json", dir))
    .find((u) => fs.existsSync(u));
  assert.ok(found, "the plugin's .mcp.json is present");
  const entry = JSON.parse(fs.readFileSync(found, "utf8")).mcpServers.brilliant;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", `${pkg.name}@${pkg.version}`]);
});
