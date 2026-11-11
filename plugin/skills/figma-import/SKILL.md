---
name: figma-import
description: Bring Figma designs into Brilliant and fix import issues. Use when the user wants to move, import, copy or migrate a Figma file, page, frame or library into Brilliant, pastes a figma.com link while working with Brilliant, or asks why an imported Figma design looks wrong.
license: Apache-2.0
---

# Figma into Brilliant

## Importing

The import is the user's act; you guide it. Load the exact steps first with `get_knowledge`,
key `reference/canvases/figma-import`, and name the button to press.

1. A whole file: in Figma, run the Brilliant plugin (Plugins, search "Brilliant") and press
   **Import to Brilliant**. Brilliant opens its import screen, where the user picks the
   project, the pages and how each library comes in. Everything is decided on that screen.
2. A Figma link: the user pastes it into the link field of Brilliant's "+" New project page.
   The screen then waits for the plugin to be opened in that file; Brilliant opens nothing
   in Figma by itself.
3. A few frames: copy in Figma, paste into Brilliant (Cmd+V). No plugin and no link; the
   design arrives as editable elements (`reference/editing/figma-paste` says what comes across).
4. Brilliant also has an `import_figma` command (through `execute_commands`) that imports by
   URL as a plain import, with no design-system variables and no library linking. Use it only
   when the user asks for that lane by name. It is not a fix for a plugin import.

## Fixing an import

1. Load `get_knowledge` with key `reference/canvases/figma-import-help` and follow it.
2. Read the project's `Migration report` canvas with `read`: it records what arrived, what
   degraded and what stayed a copy. Never edit it; the next import rewrites it.
3. Give the remedy for each issue the user reports (fonts, components kept as copies,
   library linking, pages that did not land), with the tool that runs it.
4. Anything inside Figma or on the import screen (Import again, Resume, Retry, Connect
   Figma) is the user's button. Name it exactly, and never say you pressed it.
