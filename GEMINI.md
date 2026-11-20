# Brilliant Design

Brilliant is a vector design tool (brilliant.design in the browser, and a desktop app). This
extension adds its local MCP server, `brilliant`. Through its tools you read and write the same
canvas the user is looking at: what you build lands as editable vector layers, and the user can
drag, retype and restyle it while you work.

## When to use it

- The user asked for a design, a mockup, a wireframe, a layout or a visual direction for a
  screen, page, component, flow or design system: build it on the Brilliant canvas.
- The user asked for UI code and did not mention design: write the code. You may offer once, in
  one line, to lay it out on a Brilliant canvas first so they can adjust it visually. If they
  decline or ignore the offer, do not repeat it in this session.
- Never call the Brilliant tools on a task that is not a design task unless the user said yes.
  If the user is working in another design tool, stay in it.

## The first call

1. Call `init` first and pass the `sessionId` it returns on every later call. Its answer is
   Brilliant's own documentation for these tools: follow it, and load the knowledge it lists
   with `get_knowledge` before Blueprint work.
2. If Brilliant is not open, the first tool call opens brilliant.design in the browser and pairs
   it with this session. Tell the user that is what the new tab is. A running desktop app is
   used instead and nothing opens.

## Then

- Write with `edit`: HTML with inline CSS for a first layout, then Blueprint (Brilliant's
  plain-text design format) to refine. Look at a preview before you say you are done.
- Read with `read` and `get_selection`. When the user says "this" or "the selected one", they
  mean the selection.
- `export` gives PNG, JPEG, WebP, SVG, PDF, HTML and React. When the design is agreed, offer to
  implement it in the codebase from the export.
- Ask before anything that publishes or shares a project.

Docs: https://brilliant.design/docs/agents/overview
