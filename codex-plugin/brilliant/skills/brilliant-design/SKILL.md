---
name: brilliant-design
description: Design and edit user interfaces, web pages and graphics as editable layers on a Brilliant canvas. Use when the user asks for a UI design, mockup, wireframe, website or landing page, app screen, dashboard, slide, social post or poster, wants a design they can edit by hand or hand to code, asks to remove a photo's background, or names Brilliant. Not for writing production frontend code the user asked for directly, and not for generating a photograph or an illustration.
license: Apache-2.0
---

# Designing with Brilliant

Brilliant is a vector design tool (brilliant.design in the browser, and a desktop app). What
you build lands as real, editable layers (frames, text, shapes, icons), and the user can drag,
retype and restyle it by hand while you keep working.

## When to use it

- The user asked for a design, a mockup, a wireframe, a layout or a visual direction: build it
  on a Brilliant canvas.
- The user asked for UI code and did not mention design: write the code. You may offer once, in
  one line, to lay it out on a Brilliant canvas first so they can adjust it visually. If they
  decline or ignore the offer, do not repeat it in this session.
- The user attached or linked a photo and asked to remove its background, cut out the subject
  or get a transparent PNG: use `remove_background`. It cuts the user's own photo with a matte.
  It never generates a new image.
- Never call the Brilliant tools on a task that is not a design task unless the user said yes.
  If the user is working in another design tool, stay in it.

## Which tools you have

This plugin declares two MCP servers. Pick one per task and keep to it.

1. `brilliant` (hosted, https://brilliant.design/mcp, no account, nothing to install). Tools:
   `design`, `edit_design`, `inspect_design`, `get_knowledge`, `place_image`,
   `remove_background`. Use it for a new design from a prompt and for photo cutouts. Its designs
   are scratch designs that expire after 30 days unless the user opens them in Brilliant and
   keeps them. Rows take literal values (hex colors, numbers): no design tokens in this lane.
2. `brilliant-canvas` (local, `npx -y @brilliant-hq/mcp`, pairs with a brilliant.design tab the
   user approves or with the running desktop app). Tools include `init`, `edit`, `read`,
   `get_selection`, `export`, `get_knowledge`. Use it when the user works in a repository and
   wants the design in their own Brilliant project, built on their real design tokens, read back
   and exported as HTML or React.

The tools appear under your client's MCP prefix. Use the names your client lists.

## Hosted flow (`brilliant`)

1. Load the Blueprint knowledge before writing rows: `get_knowledge` with `blueprint/core`,
   `blueprint/layout`, `blueprint/paint`, `blueprint/text` and `design/foundations`.
2. Call `design`. It starts a new, empty design and returns its seed and its link (`openUrl`).
   Give the user the link exactly as returned, including the part after `#`: that part is what
   lets the open tab report back. Nothing is drawn in the conversation; the user opens the link
   in a browser to see and edit the design.
3. Build with `edit_design` and the seed. New rows add layers; a row that leads with an existing
   id changes that layer. Send up to 8,000 characters per call, and keep calls small: about 20
   rows, such as a page's frame and its first section, lands within a few seconds. Set the frame
   and the main sections first, then fill in the details.
4. With the link open in a browser tab the rows land there live and the answer says how they
   applied. With no tab open they are stored and land when the link is opened. Do not resend
   rows that were stored.
5. Check your work with `inspect_design` (the element tree with ids, how each turn ended, and
   any rows that did not apply). It answers once a browser tab has opened the link. Fix rows
   that did not apply before you say you are done.
6. To change a design made in this conversation, call `edit_design` with its seed. Do not call
   `design` again: that starts a second, separate design.
7. `place_image` puts an image (an https URL or base64) into a design as a new image layer, or
   as the fill of a frame or shape named by its id.

## Local canvas flow (`brilliant-canvas`)

1. Call `init` first and pass the `sessionId` it returns on every later call. Its answer is
   Brilliant's own documentation for these tools, served by the user's app: follow it, and load
   the knowledge it lists with `get_knowledge` before Blueprint work.
2. If Brilliant is not open, the first tool call opens brilliant.design in the browser and pairs
   it with this session. Tell the user that is what the new tab is. A running desktop app is
   used instead and nothing opens.
3. Write with `edit`. Its `text` holds fenced blocks, each opening with a `file(path)` row such
   as `file("Projects/Pricing.bl")`: an `html` fence (HTML with inline CSS) for a first layout,
   then `bl` fences (Blueprint rows) to refine. End a `bl` fence with `preview(#ref)` to get a
   screenshot, and look at it: fix what is off before you say you are done.
4. Read with `read` and `get_selection`. When the user says "this" or "the selected one", they
   mean the selection.
5. If the repository has a design language (CSS variables, a Tailwind config, a theme file),
   read it and author it as the project's design system first (`designSystem: "new"` and a `ds`
   fence, as `init` describes), so the design uses the real tokens.
6. Ask before anything that publishes or shares a project, and say what it means first.
7. When the design is agreed, offer to implement it in the codebase from `export` (HTML or
   React) or from `read`.

## Limits to say plainly

- The hosted tools make static designs, not code or clickable prototypes.
- Hosted designs expire after 30 days unless kept in Brilliant; cutouts expire after 24 hours.
- If Brilliant cannot do something, say so. On the local canvas the user can send a request
  with `send_feedback`: it opens a card they review and send themselves.
