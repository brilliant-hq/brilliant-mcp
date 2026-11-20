# Brilliant Design: a design canvas for coding agents (MCP server)

Design canvas for coding agents: real editable vectors, auto layout, components, export to code.

```
npx -y @brilliant-hq/mcp install <client>
```

**Your coding agent designs with you on a real vector canvas.** This is the local
MCP server for [Brilliant](https://brilliant.design), the design tool whose canvas
you and your agent both edit: the agent lays out the screen, you drag, retype and
restyle it, and the agent sees your changes and keeps going.

`@brilliant-hq/mcp` is a small local router. It connects any MCP client over stdio
to a Brilliant tab in your browser or to the Brilliant desktop app, entirely on
`127.0.0.1`. **Zero bytes of MCP or design data touch Brilliant's servers.**

## Install

| Client | One line |
|---|---|
| Claude Code | `claude mcp add brilliant -- npx -y @brilliant-hq/mcp` |
| Cursor | `npx -y @brilliant-hq/mcp install cursor` |
| VS Code | `code --add-mcp '{"name":"brilliant","command":"npx","args":["-y","@brilliant-hq/mcp"]}'` |
| Codex | `codex mcp add brilliant -- npx -y @brilliant-hq/mcp` |
| Gemini CLI | `gemini mcp add brilliant -- npx -y @brilliant-hq/mcp` |
| Anything else | `npx -y @brilliant-hq/mcp install <client>` |

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=brilliant&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBicmlsbGlhbnQtaHEvbWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Brilliant_MCP-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522brilliant%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540brilliant-hq%252Fmcp%2522%255D%257D)

`install <client>` knows claude-code, cursor, vscode, codex, gemini, antigravity,
windsurf, zed, opencode, amp and claude-desktop. Any other MCP client takes the
standard stdio entry:

```json
{ "mcpServers": { "brilliant": { "command": "npx", "args": ["-y", "@brilliant-hq/mcp"] } } }
```

Requires Node 20 or newer. No API key.

## Codex plugin

This repository is also a Codex plugin marketplace. The plugin lives in
[`codex-plugin/brilliant`](./codex-plugin/brilliant) and adds a design skill, the hosted
Brilliant tools (`https://brilliant.design/mcp`, no account) and this local server:

```
codex plugin marketplace add brilliant-hq/brilliant-mcp
codex plugin add brilliant@brilliant
```

## Gemini CLI extension

This repository is also a Gemini CLI extension (`gemini-extension.json` at the root). It adds
this local server and a context file, [`GEMINI.md`](./GEMINI.md), that tells Gemini when to
design on the canvas and which call to make first:

```
gemini extensions install https://github.com/brilliant-hq/brilliant-mcp
```

## Kiro power

[`kiro-power`](./kiro-power) is a Kiro power in the Agent Plugins format: a manifest with the
keywords that activate it (design, mockup, wireframe and more), a design skill and this local
server. In Kiro, open the Powers panel, choose Add Custom Power, then Import power from GitHub,
and give it `https://github.com/brilliant-hq/brilliant-mcp/tree/main/kiro-power`.

## First run

Ask your agent for a design: "design a pricing page for this app". With no
Brilliant open, the first tool call opens `brilliant.design` in your browser
(Chrome, Edge or Firefox) and pairs it with your agent session; allow the one-time
local network prompt. If the Brilliant desktop app is running, the server connects
to it instead and opens nothing. Listing the tools never opens anything.

## What your agent can do

The tools are Brilliant's own, served by the tab or the app; this package relays
them unchanged. The main doors:

- `init`: start a session and receive Brilliant's documentation for its tools.
- `edit`: write designs, as HTML with inline CSS or as Blueprint, Brilliant's
  plain-text design format. Everything lands as editable vector layers.
- `read`, `get_selection`: read canvases, design systems and what you selected.
- `export`: PNG, JPEG, WebP, SVG, PDF, HTML and React.
- `get_knowledge`: load design and format guidance on demand.
- `generate_image`, `generate_svg`, `vectorize_image`, `remove_background`:
  image and vector generation inside a design.

Every tool carries MCP annotations (a title, read-only and destructive hints), so
your client can tell a read from a write before it calls.

## How it works

- The server is a **relay**: MCP JSON-RPC crosses it verbatim. MCP semantics live
  in the Brilliant tab or desktop app, never here.
- The first instance on a machine becomes the **leader** (one tab socket, one
  permission grant); every other MCP client's instance is a **follower** that
  forwards over loopback. Leadership reassigns when the leader exits.
- The Brilliant **desktop app** is detected on `127.0.0.1:3333` to `3335` and
  covered by the same entry.

The full wire contract is in [`PROTOCOL.md`](./PROTOCOL.md).

## Privacy

This package makes no network calls of its own: no telemetry, no analytics, no
update checks. It talks only to a `brilliant.design` tab you approve or to the
Brilliant desktop app on your machine, over `127.0.0.1`.

One thing does reach Brilliant's website: when the server opens the pairing tab,
the link carries three attribution params, `utm_source=mcp-helper`, your MCP
client's name (`utm_medium`, for example `claude-code`) and, if the install
snippet set one, a door tag (`utm_content`, from `--src <tag>` or
`BRILLIANT_MCP_SRC`). They tell us which install path people use. They say
nothing about you, your machine or your designs, and the pairing token stays in
the URL fragment, which a browser never sends to a server.

It keeps a small state directory at `~/.config/brilliant/mcp-helper` (its ports, the pairings
you approved and the last tool list), readable only by you.

Brilliant itself, like any app, has its own data handling: the image tools run on
Brilliant's servers when your agent calls them, and a cloud project syncs when you
choose one. See the [privacy policy](https://brilliant.design/privacy).

## Security

- Every listener binds the literal `127.0.0.1`: never `0.0.0.0`, never a scan of
  private ranges.
- The tab socket validates `Origin: https://brilliant.design`, a loopback `Host`
  (against DNS rebinding), and a pairing token or an association you approved.
- The pairing token is never served from any local endpoint; the state files are
  mode `0600`, and the web side never reads them.

To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## CLI

```
npx @brilliant-hq/mcp                              # run the stdio MCP server (default)
npx @brilliant-hq/mcp --src <tag>                  # run it, tagging the pairing link with an install door
npx @brilliant-hq/mcp --version
npx @brilliant-hq/mcp install <client>             # add the server to <client>'s MCP config
npx @brilliant-hq/mcp install <client> --dry-run   # preview the change, write nothing
npx @brilliant-hq/mcp install <client> --remove    # remove it again
```

`install` merges into the client's config without touching other servers, keeps
JSONC comments, and `--remove` is its exact inverse.

## Development

```
npm install
npm test
```

## Docker

The `Dockerfile` builds the same stdio server for registries that build and
inspect it (`initialize`, `tools/list`):

```
docker build -t brilliant-mcp .
docker run -i --rm brilliant-mcp
```

To design, run the server on your own machine with the commands under Install:
it pairs with a Brilliant tab or the desktop app over `127.0.0.1`, which a
container cannot reach.

## Pricing

Canvas work by your own agents over MCP is unlimited on every Brilliant plan, the
free plan included. Generated images and background removal draw on your
Brilliant AI usage. Details: https://brilliant.design/pricing

## Licence

The code in this repository is licensed under [Apache-2.0](./LICENSE). The licence
covers this local server only: the Brilliant editor, engine and services are not
open source, and the Brilliant name and logo are not licensed (see `NOTICE`).

Docs: https://brilliant.design/docs/agents/overview
