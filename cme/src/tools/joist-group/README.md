# joist-group

Implemented 2026-08-20, replacing the roadmap placeholder that previously said
*"Do not implement behavior until Product Lab provides and approves the
corresponding specification."* The owner lifted that gate explicitly, with a
narrow scope: **match the tool being replaced exactly, and invent nothing.**

## What that means in practice

These are **count-only** construction objects. There is deliberately:

- no span table
- no beam or joist sizing
- no maximum post spacing
- no footing diameter, depth, or soil bearing

The tool being replaced (`cad-sketch.js`) had none of those either. A size is a
label the estimator picks and the object carries; it is never derived from the
span. Adding real engineering here is a separate, specified project — doing it
by accident during a port would silently change quotes that are already out.

## Quantities, verbatim from the old tool

| Line | Rule | Old source |
|---|---|---|
| Joist (size to span) | **one piece per joist drawn** | `cad-sketch.js:888` |
| Beam (size to span) | **one piece per beam drawn** | `cad-sketch.js:889` |
| Joist hanger | joists × 2 (both ends) | `cad-sketch.js:894` |
| 4x4x8 post | one per post | `cad-sketch.js:890` |
| Post base / anchor | one per post | `cad-sketch.js:891` |
| Concrete 60lb bag | posts × 3 | `cad-sketch.js:892` |
| 6x6 pillar | one per pillar | `cad-sketch.js:893` |
| On-centre spacings | 12, 16, 19.2, 24 inches | `cad-sketch.js:1245` |

**Joists and beams are counted as pieces, not bought as lineal feet off a stock
length.** That distinction is load-bearing and there is a test pinning it:
ordering `ceil(totalLF × waste ÷ 16)` sticks assumes one joist's offcut becomes
the next joist. It does not — a 16 ft board yields exactly one 12 ft joist and
the tail is scrap. Eight 12 ft joists priced that way came to seven boards, and
the deck was a joist short.

There is also **no deck-area-divided-by-spacing derivation**. The joist count is
only ever what was drawn or arrayed. Adding one would change every historical
estimate at once.
