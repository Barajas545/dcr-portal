# Railing

Railing is a snap-anchored construction object created by pressing an edge, corner, or grid point and dragging freely to another active snap target. A run may cross inside or outside the Deck Boundary. Edge anchors retain normalized host references; grid anchors retain exact project coordinates.

`railing.js` owns the construction rules and serializable object contract:

- maximum 72-inch clear span between post faces;
- 3.5-inch default post width;
- the fewest equal sections that satisfy the span rule;
- project-level post deduplication at shared endpoints;
- exterior corner classification by default;
- geometry and quantities only, without pricing.

The UI resolves both anchors on every render and derives the current run geometry between them. Topology changes that would split or remove referenced construction geometry are currently blocked until dependency-aware repartitioning is implemented.

Railing visibility is independent from the Dimensions layer. Edge/corner and grid snaps can be enabled separately, with construction geometry taking priority when both are active.

Each run stores a railing `system` (`wild-hog` or `trex`) for future catalog and cost integration. Users may add panels manually, which adds posts while retaining the endpoints. Removing panels is clamped to the calculated minimum required to preserve the 72-inch maximum clear span.
