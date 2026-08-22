export function projectMapPoint(vertex, halfSize, width, height, padding = 18) {
  const [halfLatitude, halfLongitude] = halfSize;
  return [
    // The archived map stores longitude as west-positive. Canvas x grows
    // eastward, so invert it here for a conventional world orientation.
    padding + (halfLongitude - vertex[1]) / (halfLongitude * 2) * (width - padding * 2),
    padding + (halfLatitude - vertex[0]) / (halfLatitude * 2) * (height - padding * 2),
  ];
}

export function encodeHitColor(id) {
  return `rgb(${id} 255 ${255 - id})`;
}

export function decodeHitColor(pixel) {
  const coverage = pixel[1];
  if (!coverage) return 0;
  return Math.round(pixel[0] * 255 / coverage);
}
