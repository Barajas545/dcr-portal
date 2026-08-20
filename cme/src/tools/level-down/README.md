# Level Down

Level Down is an independent construction polyline representing one consistent step down across the deck surface. It begins and ends on Deck Boundary geometry, may contain intermediate grid-snapped turns, and stores one shared riser height for every segment in the polyline.

Multiple Level Down objects may coexist. Splitting a segment preserves the owning polyline and shared riser setting. The object does not modify Deck Boundary topology or Railing post layouts.
