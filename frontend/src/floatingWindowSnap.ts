export type FloatingRect = { left: number; top: number; width: number; height: number };

type Axis = 'x' | 'y';
type Limits = { min: number; max: number };
type Resize = {
  direction: 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};
type SnapEdge = { origin: number; size: number; distance: number; neighbor: FloatingRect };

function span(rect: FloatingRect, axis: Axis) {
  return axis === 'x' ? [rect.left, rect.left + rect.width] : [rect.top, rect.top + rect.height];
}

function intersectsOnAxis(a: FloatingRect, b: FloatingRect, axis: Axis) {
  const [aStart, aEnd] = span(a, axis);
  const [bStart, bEnd] = span(b, axis);
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function overlaps(a: FloatingRect, b: FloatingRect) {
  return intersectsOnAxis(a, b, 'x') && intersectsOnAxis(a, b, 'y');
}

function nearbyEdges(bounds: FloatingRect, neighbors: readonly FloatingRect[], axis: Axis, tolerance: number, limits: Limits, resize?: Resize) {
  const start = axis === 'x' ? bounds.left : bounds.top;
  const size = axis === 'x' ? bounds.width : bounds.height;
  const end = start + size;
  const snapStart = !resize || resize.direction.includes(axis === 'x' ? 'w' : 'n');
  const snapEnd = !resize || resize.direction.includes(axis === 'x' ? 'e' : 's');
  const minSize = resize ? (axis === 'x' ? resize.minWidth : resize.minHeight) : size;
  const maxSize = resize ? (axis === 'x' ? resize.maxWidth : resize.maxHeight) : size;
  const edges: SnapEdge[] = [];

  function addEdge(neighbor: FloatingRect, position: number, atStart: boolean) {
    const offset = Math.abs(position - (atStart ? start : end));
    if (!offset || offset > tolerance) return;
    const origin = atStart ? position : resize ? start : position - size;
    const extent = resize ? (atStart ? end - position : position - start) : size;
    if (origin < limits.min || origin > limits.max || extent < minSize || extent > maxSize) return;
    // Compare displacements in screen space even when the workspace uses scaled coordinates.
    edges.push({ origin, size: extent, distance: offset / tolerance, neighbor });
  }

  for (const neighbor of neighbors) {
    if (neighbor.width <= 0 || neighbor.height <= 0) continue;
    const [near, far] = span(neighbor, axis);
    if (snapStart) addEdge(neighbor, far, true);
    if (snapEnd) addEdge(neighbor, near, false);
  }
  return edges;
}

/** Joins nearby opposite edges without introducing an overlap or shifting a fixed resize edge. */
export function snapFloatingWindow(bounds: FloatingRect, neighbors: readonly FloatingRect[], tolerance: { x: number; y: number }, limits: Limits, resize?: Resize): FloatingRect {
  const vertical = nearbyEdges(bounds, neighbors, 'x', tolerance.x, limits, resize);
  const horizontal = nearbyEdges(bounds, neighbors, 'y', tolerance.y, limits, resize);
  if (!vertical.length && !horizontal.length) return bounds;

  const obstacles = neighbors.filter(neighbor => !overlaps(bounds, neighbor));
  let result = bounds;
  let closest = Infinity;
  let nextClosest = Infinity;

  function consider(x: SnapEdge | undefined, y: SnapEdge | undefined) {
    const primary = Math.min(x?.distance ?? Infinity, y?.distance ?? Infinity);
    const secondary = Math.max(x?.distance ?? Infinity, y?.distance ?? Infinity);
    // Keep the nearest dock and add a second edge only when it can share that dock.
    if (primary > closest || (primary === closest && secondary >= nextClosest)) return;

    const snapped = {
      left: x?.origin ?? bounds.left, width: x?.size ?? bounds.width,
      top: y?.origin ?? bounds.top, height: y?.size ?? bounds.height,
    };
    if ((x && !intersectsOnAxis(snapped, x.neighbor, 'y')) || (y && !intersectsOnAxis(snapped, y.neighbor, 'x'))) return;
    if (obstacles.some(neighbor => overlaps(snapped, neighbor))) return;

    closest = primary;
    nextClosest = secondary;
    result = snapped;
  }

  for (const edge of vertical) consider(edge, undefined);
  for (const edge of horizontal) consider(undefined, edge);
  for (const x of vertical) for (const y of horizontal) consider(x, y);
  return result;
}
