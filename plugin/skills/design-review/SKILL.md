---
name: design-review
description: Review a design visually and propose concrete fixes. Use when the user asks for a design critique, a UI review, a polish pass, a contrast or accessibility check, or "what is wrong with this screen", for a Brilliant canvas, the selection on it, or a page of their running app.
license: Apache-2.0
---

# Design review

1. Get the design in front of you.
   - On a Brilliant canvas: call `init`, then `get_selection` (or `read` with the canvas
     path), then `export` the target as png and look at it. Review what you see, not only
     what the rows say.
   - A page of the user's own app: take a screenshot with the browser tool you have. To try
     fixes visually, offer to recreate the page on a Brilliant canvas with an `html` fence,
     and do it only on a yes.
2. Load the review knowledge: `get_knowledge` with keys `design/foundations`,
   `design/colors` and `design/typography`.
3. Judge in this order and report at most 10 numbered findings, most important first:
   hierarchy (one focal point per section), spacing rhythm, alignment, type scale, color
   roles and contrast (WCAG AA: 4.5:1 for body text, 3:1 for large text), consistency of
   repeated parts (should they be components), states and empty content, copy length.
   Each finding says what, where (the layer name or its `#ref`), why it matters, and the fix.
4. `edit` and `preview` results already carry composition notes. Use them, and do not repeat
   a note the tool reported word for word.
5. Offer to apply the fixes. Apply only the ones the user picks, as `bl` rows ending in
   `preview(#ref)`, then show before and after.
