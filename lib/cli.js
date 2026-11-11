// cli.js: argv routing for `npx @brilliant-hq/mcp`.
//   (no args)            -> stdio MCP mode (the universal denominator).
//   --version | -v       -> print the package version.
//   --help | -h          -> usage.
//   install <client>     -> merge the stdio server into <client>'s MCP config.
//   install <client> --remove | --dry-run

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStdio } from "./stdio.js";
import { installClient, removeClient, loadClients, installableClientIds } from "./install.js";

function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const USAGE = `brilliant-mcp: no-config local MCP bridge for brilliant.design

Usage:
  npx @brilliant-hq/mcp                    Run the stdio MCP server (default).
  npx @brilliant-hq/mcp --src <tag>        Run it, tagging the pairing link with the door it was installed from.
  npx @brilliant-hq/mcp --version          Print the version.
  npx @brilliant-hq/mcp install <client>   Add the MCP server to <client>'s config.
  npx @brilliant-hq/mcp install <client> --dry-run   Preview without writing.
  npx @brilliant-hq/mcp install <client> --remove    Remove it again.

Configure once, ever:
  claude mcp add brilliant -- npx -y @brilliant-hq/mcp
`;

/** `install <client> [--remove] [--dry-run]`: edits the tool's MCP config. */
function runInstall(argv) {
  const rest = argv.slice(1);
  const remove = rest.includes("--remove");
  const dryRun = rest.includes("--dry-run") || rest.includes("--print");
  const client = rest.find((a) => !a.startsWith("-"));

  if (!client) {
    const ids = installableClientIds();
    process.stdout.write(
      `Usage: npx @brilliant-hq/mcp install <client> [--remove] [--dry-run]\n` +
        `Supported clients:\n  ${ids.join("\n  ")}\n`,
    );
    return 2;
  }

  const table = loadClients();
  const fn = remove ? removeClient : installClient;
  const res = fn(client, { clients: table, dryRun });

  if (!res.ok) {
    process.stderr.write(`${res.error}\n`);
    if (res.known) {
      process.stderr.write(`Supported clients: ${res.known.join(", ")}\n`);
    }
    return 2;
  }

  const meta = table.clients.find((c) => c.id === client);
  switch (res.action) {
    case "wrote":
      process.stdout.write(
        `Added Brilliant to ${meta.displayName} (${res.configPath}).\n` +
          `${meta.restartHint || "Restart the client to connect."}\n`,
      );
      break;
    case "unchanged":
      process.stdout.write(
        `Brilliant is already configured in ${meta.displayName} ` +
          `(${res.configPath}).\n`,
      );
      break;
    case "would-write":
      process.stdout.write(
        `Would add Brilliant to ${meta.displayName} (${res.configPath}):\n\n` +
          `${res.preview}\n`,
      );
      break;
    case "removed":
      process.stdout.write(
        `Removed Brilliant from ${meta.displayName} (${res.configPath}).\n`,
      );
      break;
    case "would-remove":
      process.stdout.write(
        `Would remove Brilliant from ${meta.displayName} ` +
          `(${res.configPath}):\n\n${res.preview}\n`,
      );
      break;
    case "absent":
      process.stdout.write(
        `Brilliant was not configured in ${meta.displayName} ` +
          `(${res.configPath}); nothing to remove.\n`,
      );
      break;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(packageVersion() + "\n");
    return 0;
  }
  if (cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === "install") {
    return runInstall(argv);
  }
  // `--src <tag>` / `--src=<tag>`: the door tag an install snippet carries. It
  // rides the pairing URL as utm_content and is otherwise unused.
  if (cmd === "--src" || (cmd && cmd.startsWith("--src="))) {
    const tag = cmd === "--src" ? argv[1] : cmd.slice("--src=".length);
    if (!tag || tag.startsWith("-")) {
      process.stderr.write(`--src needs a tag\n\n${USAGE}`);
      return 2;
    }
    process.env.BRILLIANT_MCP_SRC = tag;
    await runStdio();
    return 0;
  }
  if (cmd && cmd.startsWith("-")) {
    process.stderr.write(`unknown flag: ${cmd}\n\n${USAGE}`);
    return 2;
  }
  if (cmd && !cmd.startsWith("-")) {
    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }

  // Default: stdio MCP mode. Never returns (runs until stdin closes / SIGTERM).
  await runStdio();
  return 0;
}
