export const MIN_VIEW_WIDTH = 24;
export const MAX_VIEW_WIDTH = 12_000;

export function createViewport(x = -30, y = -25, width = 360, height = 250) {
  return { x, y, width, height };
}

/* Reshape the visible world to the shape of the element showing it.

   The viewBox had a fixed 360x250 shape while the canvas is whatever the
   window is, so SVG's default preserveAspectRatio letterboxed it: on a wide
   monitor that left a dark, gridless band down each side. Matching the ratio
   is what makes the grid reach the edges.

   The SHORT side grows rather than the long side shrinking, so reshaping can
   only ever reveal more world - nothing that was on screen is pushed off it
   by resizing the window. */
export function matchViewportAspect(viewport, aspectRatio) {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return viewport;
  const current = viewport.width / viewport.height;
  if (!Number.isFinite(current) || Math.abs(current - aspectRatio) < 1e-6) return viewport;
  const centerX = viewport.x + viewport.width / 2;
  const centerY = viewport.y + viewport.height / 2;
  const width = current < aspectRatio ? viewport.height * aspectRatio : viewport.width;
  const height = current < aspectRatio ? viewport.height : viewport.width / aspectRatio;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

export function zoomViewport(viewport, worldAnchor, factor) {
  const nextWidth = Math.max(MIN_VIEW_WIDTH, Math.min(MAX_VIEW_WIDTH, viewport.width * factor));
  const appliedFactor = nextWidth / viewport.width;
  const nextHeight = viewport.height * appliedFactor;
  return {
    x: worldAnchor.x - (worldAnchor.x - viewport.x) * appliedFactor,
    y: worldAnchor.y - (worldAnchor.y - viewport.y) * appliedFactor,
    width: nextWidth,
    height: nextHeight,
  };
}

export function panViewport(viewport, delta) {
  return { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y };
}

export function fitViewport(points, aspectRatio, padding = 36) {
  if (!points.length) return createViewport();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  let width = Math.max(MIN_VIEW_WIDTH, maxX - minX);
  let height = Math.max(MIN_VIEW_WIDTH / aspectRatio, maxY - minY);
  if (width / height < aspectRatio) width = height * aspectRatio;
  else height = width / aspectRatio;
  return { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height };
}

export function adaptiveGridSpacing(viewportWidth, pixelWidth, preferredPixels = 18) {
  const choices = [.5, 1, 2, 6, 12, 24, 48, 96, 192, 384];
  const desiredWorldSpacing = viewportWidth * preferredPixels / Math.max(pixelWidth, 1);
  return choices.find((spacing) => spacing >= desiredWorldSpacing) ?? choices.at(-1);
}
