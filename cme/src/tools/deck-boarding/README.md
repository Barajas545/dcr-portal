# Deck Boarding Direction

Each Deck Boundary may own one serializable board-direction definition. A selected construction line supplies the reference angle and origin; the stored board width and gap produce a repeatable pitch. Rendering derives clipped parallel segments from the boundary polygon and may subtract attached Stair footprints so the pattern remains a deck-surface property rather than stair geometry.

The initial construction defaults are a 5.5-inch board width and a 3/16-inch gap. They remain explicit data so a future product/material selection can replace them without changing the interaction model.
