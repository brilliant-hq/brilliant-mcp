# Brilliant for Claude Code

Your agent can design. It just cannot design with you. Brilliant gives Claude Code a real
vector canvas you both work on: Claude lays out the screen, you drag, retype and restyle it,
Claude sees your changes and keeps going. Designs are plain text (`.bl`), so they diff,
review and live in your repo like code.

## Install

In a Claude Code session:

    /plugin install brilliant-design --marketplace brilliant-hq/brilliant-mcp

Or from the shell:

    claude plugin install brilliant-design --marketplace brilliant-hq/brilliant-mcp

Then ask: "design a pricing page for this app, using our Tailwind theme". The first design
call opens brilliant.design in your browser (Chrome, Edge or Firefox) and pairs it with the
session. The Brilliant desktop app is used instead when it is running.

## What you get

- **brilliant-canvas**: Claude designs screens, components and design systems on a live
  canvas, using your codebase's real tokens, and checks its own work visually.
- **design-review**: ask "review this screen" for a numbered critique and fixes you pick.
- **figma-import**: guidance for moving Figma files and frames into Brilliant, and for
  fixing import issues.
- The Brilliant MCP server (`@brilliant-hq/mcp`, pinned to an exact version): edit, read,
  export to HTML or React, and generate images and vectors inside your design.

## Examples

1. "Design an onboarding flow for this app in three screens, matching our CSS variables."
2. "Review the checkout canvas for contrast and spacing, and fix what you find."
3. "I want to bring the Settings page of our Figma file into Brilliant. Walk me through it."

## What it runs, sends and stores

The plugin starts `npx -y @brilliant-hq/mcp@<pinned version>`, an open-source local relay
(the source is at the root of this repository). It talks only to a brilliant.design tab you
approve or to the Brilliant desktop app on your machine, over 127.0.0.1; MCP traffic and
design data do not pass through Brilliant's servers, and the relay makes no network calls
of its own. When it opens the pairing tab, the link carries three attribution params (the
source `mcp-helper`, your client's name, and the tag `claude-plugin`), so Brilliant can
count plugin installs; they say nothing about you or your designs. It keeps a small state
folder at `~/.config/brilliant/mcp-helper`.

The skills are plain instructions. They tell Claude to call Brilliant's `init` tool, which
returns Brilliant's own documentation for its tools from your running tab or app; nothing is
fetched from any other source.

Inside Brilliant, image generation, background removal and vectorizing run on Brilliant's
servers when Claude calls them as part of a design, and a cloud project syncs when you
choose one. Privacy policy: https://brilliant.design/privacy

## Pricing

Canvas work by your own agents is unlimited on every Brilliant plan, the free plan included.
Generated images and background removal draw on your Brilliant AI usage:
https://brilliant.design/pricing

## Support

https://brilliant.design/contact

## Licence

Apache-2.0 for the files of this plugin. Brilliant itself is not open source.
