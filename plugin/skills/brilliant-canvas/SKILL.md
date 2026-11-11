---
name: brilliant-canvas
description: Design user interfaces visually on Brilliant's vector canvas together with the user. Use when the user asks to design, mock up, lay out or restyle a screen, page, component, flow or design system and wants to see or edit it visually; when they mention Brilliant, a .bl or .ds file, or the Brilliant canvas; or when they want a design they can hand to code. Not for writing production frontend code the user asked for directly.
license: Apache-2.0
---

# Designing on the Brilliant canvas

Brilliant is a vector design tool (a desktop app and brilliant.design in the browser). Through
the Brilliant MCP tools you read and write the same canvas the user is looking at: what you
build lands as editable layers, and the user can drag, retype and restyle it while you work.

## When to use it

- The user asked for a design, a mockup, a layout or a visual direction: build it on the canvas.
- The user asked for UI code and did not mention design: write the code. You may offer once, in
  one line, to lay it out on a Brilliant canvas first so they can adjust it visually. If they
  decline or ignore the offer, do not repeat it in this session.
- Never call the Brilliant tools on a task that is not a design task unless the user said yes.
  If the user is working in another design tool, stay in it.

## How to work

1. Call the Brilliant `init` tool first and pass the `sessionId` it returns on every later
   call. Its answer is Brilliant's own documentation for these tools, served by the user's
   app: follow it, and load the knowledge it lists with `get_knowledge` before Blueprint work.
2. The tools appear under your client's MCP prefix. Installed through this plugin they are
   `mcp__plugin_brilliant-design_brilliant__<tool>`; where the documentation writes
   `mcp__brilliant__<tool>`, use the name your client lists. If two sets of Brilliant tools
   are listed (this plugin's and a server the user added by hand), they reach the same canvas:
   pick one set and keep to it for the whole task.
3. If Brilliant is not open, the first tool call opens brilliant.design in the browser and
   pairs it with this session. Tell the user that is what the new tab is. A running desktop
   app is used instead and nothing opens.
4. Write with `edit`. Its `text` holds fenced blocks, each opening with a `file(path)` row
   such as `file("Projects/Pricing.bl")`: an `html` fence (HTML with inline CSS) for a first
   layout, then `bl` fences (Blueprint rows) to refine. End a `bl` fence with `preview(#ref)`
   to get a screenshot, and look at it: fix what is off before you say you are done.
5. Read with `read` and `get_selection`. When the user says "this" or "the selected one",
   they mean the selection.
6. If the repository has a design language (CSS variables, a Tailwind config, a theme file),
   read it and author it as the project's design system first (`designSystem: "new"` and a
   `ds` fence, as `init` describes), so the design uses the real tokens.
7. Ask before anything that publishes or shares a project, and say what it means first.
8. When the design is agreed, offer to implement it in the codebase from `export` (HTML or
   React) or from `read`.

## If the Brilliant tools are not available

Tell the user the one line that connects their agent, `npx -y @brilliant-hq/mcp install <client>`
(claude-code, cursor, vscode, codex, gemini, antigravity, windsurf, zed, opencode, amp or
claude-desktop), and stop. Never run it without the user's yes.

## If Brilliant cannot do something

Say so plainly. The user can send a request with `send_feedback`: it opens a card they
review and send themselves, and it sends nothing on its own.
