# Brilliant Design for Claude

Ask Claude for a landing page, an app screen, a dashboard, a slide or a social post, and get a
real design instead of a description. Claude builds it in Brilliant as editable layers and
gives you a link. Open the link and the design is there in the Brilliant editor in your
browser: drag it, retype the copy, change a color, or tell Claude what to change and the same
design updates. It needs no Brilliant account and no desktop app.

The plugin works in Claude chat, in Cowork and in Claude Code.

## What you get

- **brilliant-canvas**: teaches Claude when to design and how to build and change a design
  with Brilliant's tools.
- **design-review**: ask "review this design" for a numbered critique and the fixes you pick.
- **figma-import**: guidance for moving a Figma file, page or frames into Brilliant, and for
  fixing an import.
- The Brilliant connector (`https://brilliant.design/mcp/claude`) with four tools: `design`
  starts a design and returns its link, `edit_design` adds to it or changes it,
  `inspect_design` reads it back, and `get_knowledge` loads Brilliant's own documentation.

## How to use it

1. Install the plugin. In Claude chat and Cowork, open the plugin's Connectors tab and add
   or connect Brilliant; it has no sign-in. Claude Code connects by itself. To install in
   Claude Code straight from this repository:

       /plugin install brilliant --marketplace brilliant-hq/brilliant-mcp

2. Ask: "Design a pricing page for my SaaS with three tiers."
3. Open the link Claude gives you. Edit by hand, or keep talking: "Make the button blue."

## Limits

- The design is not drawn inside the conversation. It opens in your browser.
- Designs made this way are scratch designs. They expire after 30 days unless you open them
  in Brilliant and keep them.
- Claude can read a design back only after a browser tab has opened its link.
- These tools make static designs, not code or clickable prototypes, and they do not generate
  photos or illustrations. Colors and sizes are literal values, not design tokens.

## What it runs, sends and stores

The plugin runs nothing on your computer. Its skills are plain instructions, and its one
connector is Brilliant's own hosted server at `https://brilliant.design/mcp/claude`. When
Claude calls a tool, Brilliant receives that tool's arguments: the design's title, a one-line
intent, the design rows Claude wrote, and the design's id. Brilliant stores the design so the
link can open it, for 30 days unless you keep it. Nothing else from your conversation is
sent, and the plugin reaches no other host. Privacy policy: https://brilliant.design/privacy

## Working in a codebase

In Claude Code, Brilliant also has a local lane that designs in your repository with your
real design tokens, in the Brilliant desktop app or a browser tab you pair, and exports to
HTML or React. It is the `brilliant-design` plugin in the `plugin` folder of this repository.
Setup: https://brilliant.design/docs/agents/overview

## Support

https://brilliant.design/contact or hello@brilliant.design

## Licence

Apache-2.0 for the files of this plugin. Brilliant itself is not open source.
