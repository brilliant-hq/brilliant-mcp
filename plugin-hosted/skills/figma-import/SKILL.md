---
name: figma-import
description: Guide the user in bringing Figma designs into Brilliant and in fixing import issues. Use when the user wants to move, import, copy or migrate a Figma file, page or frames into Brilliant, pastes a figma.com link while working with Brilliant, or asks why an imported Figma design looks wrong.
license: Apache-2.0
---

# Figma into Brilliant

The import is the user's act, done in Figma and in the Brilliant editor. You guide it. The
Brilliant connector's tools do not import anything, and you never say you pressed a button.

## Importing

Load the exact steps first with `get_knowledge`, key `reference/canvases/figma-import`, and
name the button to press.

1. A whole file: in Figma, run the Brilliant plugin (Plugins, search "Brilliant") and press
   **Import to Brilliant**. Brilliant opens its import screen, where the user picks the
   project, the pages and how each library comes in. Everything is decided on that screen.
2. A Figma link: the user pastes it into the link field of Brilliant's "+" New project page.
   The screen then waits for the plugin to be opened in that file; Brilliant opens nothing
   in Figma by itself.
3. A few frames: copy in Figma, paste into Brilliant. No plugin and no link; the design
   arrives as editable elements (`reference/editing/figma-paste` says what comes across).

## Fixing an import

1. Load `get_knowledge` with key `reference/canvases/figma-import-help` and follow it.
2. Ask the user what the project's `Migration report` canvas says: it records what arrived,
   what degraded and what stayed a copy. You cannot read it from here.
3. Give the remedy for each issue the user reports (fonts, components kept as copies,
   library linking, pages that did not land), and say who does it: every remedy inside Figma
   or on the import screen (Import again, Resume, Retry, Connect Figma) is the user's button.
   Name it exactly.
