export const CAPITAL_MARKER_OVERRIDES = {
  // The archived UK center sits near the English Channel and visually reads
  // as continental Europe. Keep the marker on an interior southern-England
  // triangle so it remains unambiguous at the game's rendered scale.
  UNITED_KINGDOM: [5310.33, 2317.33],
  RUSSIA: [6500, -8200],
  JAPAN: [2153, -22133.33],
};

export function mapProjectionFrame(width, height, padding = 18, minimumAspect = 1.5) {
  const frameWidth = width;
  const frameHeight = width / height < minimumAspect ? width / minimumAspect : height;
  return {
    x: 0,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
    padding: Math.min(padding, frameWidth / 4, frameHeight / 4),
  };
}

export function projectMapPoint(vertex, halfSize, width, height, padding = 18) {
  const [halfLatitude, halfLongitude] = halfSize;
  const frame = mapProjectionFrame(width, height, padding);
  return [
    // The archived map stores longitude as west-positive. Canvas x grows
    // eastward, so invert it here for a conventional world orientation.
    frame.x + frame.padding + (halfLongitude - vertex[1]) / (halfLongitude * 2) * (frame.width - frame.padding * 2),
    frame.y + frame.padding + (halfLatitude - vertex[0]) / (halfLatitude * 2) * (frame.height - frame.padding * 2),
  ];
}

export function pinchMapView(start, current, minimumZoom = 1, maximumZoom = 4) {
  const zoom = Math.max(minimumZoom, Math.min(maximumZoom, start.zoom * current.distance / Math.max(1, start.distance)));
  if (zoom === minimumZoom) return { zoom, panX: 0, panY: 0 };
  const scale = zoom / start.zoom;
  return {
    zoom,
    panX: current.centerX - current.canvasWidth / 2
      - scale * (start.centerX - start.canvasWidth / 2 - start.panX),
    panY: current.centerY - current.canvasHeight / 2
      - scale * (start.centerY - start.canvasHeight / 2 - start.panY),
  };
}

export function encodeHitColor(id) {
  return `rgb(${id} 255 ${255 - id})`;
}

export function decodeHitColor(pixel) {
  const coverage = pixel[1];
  if (!coverage) return 0;
  return Math.round(pixel[0] * 255 / coverage);
}
