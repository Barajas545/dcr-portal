# Stairs

Stairs is the first construction object that enriches and reshapes existing Deck Boundary geometry.

Users select a boundary construction edge and define the staircase rather than drawing individual steps. The drag reports total rise first; CME then calculates equal risers between 5 and 7.5 inches, equal treads between 10 and 11 inches, total run, opening vertices, generated boundary segments, and construction-correct plan graphics.

The Stair object stores dimensions and stable references to its host boundary and generated anchors. Completed stairs have a selectable Dimensions-layer label, exact editable dimensions, draggable parallel side lines, six-inch base-node snaps, and a safe delete operation that restores the host Deck Boundary. Individual stair-only nodes are intentionally not editable.

A staircase may connect to a lower Deck Boundary when its complete lower landing line fits inside that deck surface. When two decks share the clicked edge, CME automatically uses the higher deck as the Stair host so the drag enters the lower surface. The level difference becomes authoritative total rise. CME regenerates an established staircase when connected deck levels change; if no valid equal-riser, equal-tread, or landing solution remains, the same object stays visible in red with a reason and is excluded from future estimating outputs until recreated.

The initial implementation provides planning geometry, not code-compliance or structural approval. Those policies require future Product Lab specifications and jurisdiction-aware validation.
