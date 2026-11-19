---
name: design-review
description: Review a Brilliant design and propose concrete fixes. Use when the user asks for a design critique, a UI review, a polish pass, a contrast or accessibility check, or "what is wrong with this design", for a design made with Brilliant in this conversation.
license: Apache-2.0
---

# Design review

1. Get the design in front of you. Call `inspect_design` with the design's `seed` and
   `wait: true`. It returns the element tree with ids once a browser tab has opened the
   design's link. If no tab has opened it yet, ask the user to open the link first.
   You are reading the rows, not a picture: say so, and do not claim to have seen the design.
   If the user shares a screenshot, review that as well.
2. Load the review knowledge: `get_knowledge` with keys `design/foundations`,
   `design/colors` and `design/typography`.
3. Judge in this order and report at most 10 numbered findings, most important first:
   hierarchy (one focal point per section), spacing rhythm, alignment, type scale, color
   roles and contrast (WCAG AA: 4.5:1 for body text, 3:1 for large text, computed from the
   hex values in the rows), consistency of repeated parts, states and empty content, copy
   length. Each finding says what, where (the layer's name or id), why it matters, and the fix.
4. Offer to apply the fixes. Apply only the ones the user picks, with `edit_design` rows that
   lead with the ids from the tree, then call `inspect_design` again and report what changed.
