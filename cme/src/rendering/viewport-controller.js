export const MIN_VIEW_WIDTH = 24;
export const MAX_VIEW_WIDTH = 12_000;

export function createViewport(x = -30, y = -25, width = 360, height = 250) {
  return { x, y, width, height };
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
