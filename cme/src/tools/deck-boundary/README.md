# Deck Boundary

Deck Boundary defines the authoritative walkable surface and primary footprint of a deck project. It is CME's first production construction object and establishes the extension pattern for future tools.

## Model contract

A boundary is a closed, ordered set of stable vertices and edges measured in inches. It includes:

- a versioned, serializable object schema;
- stable IDs that future construction objects can reference;
- explicit edge roles for construction relationships;
- derived area and perimeter values;
- validation diagnostics for minimum edge length and self-intersection.

Computed values are conveniences rather than independent source data. The ordered vertices and edge relationships remain authoritative.

## Editing operations

The module exposes creation, vertex movement, edge splitting, vertex removal, edge-role updates, and validation as immutable operations. The UI uses these same operations through the project document and command-history layers.

## Future integration

House Attachment, Stairs, Railing, Fascia, Picture Frame, framing, and takeoff should reference boundary edge and vertex IDs rather than copying geometry. Schema changes must be versioned and accompanied by migration guidance and tests.
