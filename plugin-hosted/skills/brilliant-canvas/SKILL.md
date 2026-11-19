---
name: brilliant-canvas
description: Design user interfaces as real, editable designs in Brilliant. Use when the user asks to design, mock up, wireframe, lay out or restyle a page, an app screen, a dashboard, a slide, a poster or a social post and wants something they can open and edit, or when they mention Brilliant. Not for writing production frontend code the user asked for directly, and not for generating photos or illustrations.
license: Apache-2.0
---

# Designing in Brilliant

Brilliant is a vector design tool. Through the Brilliant connector you start a design, build
it as editable layers (frames, text, shapes, icons) and change it as the user talks. The
design opens in the Brilliant editor in the user's browser. It is not drawn in the
conversation.

## When to use it

- The user asked for a design, a mockup, a wireframe or a layout: build it in Brilliant.
- The user asked for UI code and did not mention design: write the code. You may offer once,
  in one line, to lay it out in Brilliant first so they can adjust it visually. If they
  decline or ignore the offer, do not repeat it in this conversation.
- Never call the Brilliant tools on a task that is not a design task unless the user said yes.
  If the user is working in another design tool, stay in it.

## The tools

Four tools, listed under the name your client gives the Brilliant connector: `design`,
`edit_design`, `inspect_design` and `get_knowledge`.

If your client instead lists Brilliant tools named `init`, `edit` and `read`, the user has
Brilliant's local lane (the desktop app or a paired browser tab). Use that set for the whole
task: call `init` first and follow the documentation it returns, not the steps below.

## How to work

1. Call `design` with a short `title` and a one-line `intent`. It starts a new, empty design
   and returns its link and its `seed`. Every call starts a new design, so call it once per
   design and keep the seed.
2. Give the user the link and say that the design opens in their browser.
3. Before you write rows, load the knowledge with `get_knowledge`: keys `blueprint/core`,
   `blueprint/layout`, `blueprint/paint`, `blueprint/text` and `design/foundations`.
4. Build with `edit_design`: pass the `seed` and Blueprint rows. Send the frame and the first
   section first (about 20 rows), then the rest in further calls. A call carries up to 8,000
   characters. Rows take literal values (hex colors, numbers); design tokens are not
   available here.
5. Read each answer. It says how the rows applied and names any row that did not. Fix those
   before you tell the user the design is done.
6. With the link open in a browser tab, rows land there within a few seconds. With no tab
   open they are stored and land when the link is opened. Tell the user which one happened.
7. To change a design, call `edit_design` again with the same seed. A row that leads with an
   id the design already has changes that layer; a new row adds one. Get ids from
   `inspect_design`.
8. `inspect_design` returns the element tree only after a browser tab has opened the link.
   Before that, say so and do not describe the design as if you had seen it. The user also
   edits by hand, so inspect before you change something they may have moved.

## What to tell the user plainly

- These are scratch designs. They expire after 30 days unless the user opens them in
  Brilliant and keeps them.
- No Brilliant account is needed.
- This lane makes static designs. It does not write code, make clickable prototypes or
  generate photos or illustrations. If Brilliant cannot do something, say so.
