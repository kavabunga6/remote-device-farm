export type FloatingRect = { left: number; top: number; width: number; height: number };

type Axis = 'x' | 'y';
export type AlignmentGuide = { axis: Axis; position: number; start: number; end: number };

type Limits = { min: number; max: number };
type Resize = {
  direction: 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};
type SnapCandidate = { origin: number; size: number; distance: number; neighbor: FloatingRect } & (
  { kind: 'dock' } | { kind: 'align'; position: number; gap: number }
);
type SnapResult = { bounds: FloatingRect; guides: AlignmentGuide[] };

function span(rect: FloatingRect, axis: Axis) {
  return axis === 'x' ? [rect.left, rect.left + rect.width] : [rect.top, rect.top + rect.height];
}

function perpendicular(axis: Axis): Axis {
  return axis === 'x' ? 'y' : 'x';
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
  const edges: SnapCandidate[] = [];

  function addEdge(neighbor: FloatingRect, position: number, atStart: boolean) {
    const offset = Math.abs(position - (atStart ? start : end));
    if ((!offset && resize) || offset > tolerance) return;
    const origin = atStart ? position : resize ? start : position - size;
    const extent = resize ? (atStart ? end - position : position - start) : size;
    if (origin < limits.min || origin > limits.max || extent < minSize || extent > maxSize) return;
    // Compare displacements in screen space even when the workspace uses scaled coordinates.
    edges.push({ kind: 'dock', origin, size: extent, distance: offset ? offset / tolerance : 0, neighbor });
  }

  for (const neighbor of neighbors) {
    if (neighbor.width <= 0 || neighbor.height <= 0) continue;
    const [near, far] = span(neighbor, axis);
    if (snapStart) addEdge(neighbor, far, true);
    if (snapEnd) addEdge(neighbor, near, false);
  }
  return edges;
}

function nearbyAlignments(bounds: FloatingRect, neighbors: readonly FloatingRect[], axis: Axis, tolerance: number, limits: Limits) {
  const [start, end] = span(bounds, axis);
  const size = end - start;
  const [crossStart, crossEnd] = span(bounds, perpendicular(axis));
  const alignments: SnapCandidate[] = [];

  for (const neighbor of neighbors) {
    if (neighbor.width <= 0 || neighbor.height <= 0) continue;
    const [near, far] = span(neighbor, axis);
    const [crossNear, crossFar] = span(neighbor, perpendicular(axis));
    const gap = Math.max(0, crossNear - crossEnd, crossStart - crossFar);
    for (const anchor of [0, .5, 1]) {
      const position = near + (far - near) * anchor;
      const offset = Math.abs(position - (start + size * anchor));
      const origin = Math.round(position - size * anchor);
      if (offset > tolerance || origin < limits.min || origin > limits.max) continue;
      alignments.push({ kind: 'align', origin, size, distance: offset ? offset / tolerance : 0, neighbor, position, gap });
    }
  }
  return alignments;
}

function isCloser(score: readonly number[], closest: readonly number[]) {
  for (const [index, value] of score.entries()) {
    if (value !== closest[index]) return value < closest[index];
  }
  return false;
}

function guideFor(bounds: FloatingRect, axis: Axis, candidate?: SnapCandidate): AlignmentGuide[] {
  if (candidate?.kind !== 'align') return [];
  const cross = perpendicular(axis);
  const [start, end] = span(bounds, cross);
  const [near, far] = span(candidate.neighbor, cross);
  return [{ axis, position: candidate.position, start: Math.min(start, near), end: Math.max(end, far) }];
}

/** Docks opposite edges and aligns matching edges or centers without introducing an overlap. */
export function snapFloatingWindow(bounds: FloatingRect, neighbors: readonly FloatingRect[], tolerance: { x: number; y: number }, limits: Limits, resize?: Resize): SnapResult {
  const vertical = nearbyEdges(bounds, neighbors, 'x', tolerance.x, limits, resize);
  const horizontal = nearbyEdges(bounds, neighbors, 'y', tolerance.y, limits, resize);
  if (!resize) {
    vertical.push(...nearbyAlignments(bounds, neighbors, 'x', tolerance.x / 2, limits));
    horizontal.push(...nearbyAlignments(bounds, neighbors, 'y', tolerance.y / 2, limits));
  }
  if (!vertical.length && !horizontal.length) return { bounds, guides: [] };

  const obstacles = neighbors.filter(neighbor => !overlaps(bounds, neighbor));
  let result: SnapResult = { bounds, guides: [] };
  let closest = [Infinity, Infinity, Infinity, Infinity, Infinity];

  function consider(x: SnapCandidate | undefined, y: SnapCandidate | undefined) {
    const dx = x?.kind === 'dock' ? x.distance : Infinity;
    const dy = y?.kind === 'dock' ? y.distance : Infinity;
    const ax = x?.kind === 'align' ? x.distance : Infinity;
    const ay = y?.kind === 'align' ? y.distance : Infinity;
    const gap = (x?.kind === 'align' ? x.gap : 0) + (y?.kind === 'align' ? y.gap : 0);
    // Preserve the closest dock, then line up the other axis if both candidates still fit.
    const score = [Math.min(dx, dy), Math.max(dx, dy), Math.min(ax, ay), Math.max(ax, ay), gap];
    if (!isCloser(score, closest)) return;

    const snapped = {
      left: x?.origin ?? bounds.left, width: x?.size ?? bounds.width,
      top: y?.origin ?? bounds.top, height: y?.size ?? bounds.height,
    };
    if ((x?.kind === 'dock' && !intersectsOnAxis(snapped, x.neighbor, 'y')) ||
      (y?.kind === 'dock' && !intersectsOnAxis(snapped, y.neighbor, 'x'))) return;
    if (obstacles.some(neighbor => overlaps(snapped, neighbor))) return;

    closest = score;
    result = { bounds: snapped, guides: [...guideFor(snapped, 'x', x), ...guideFor(snapped, 'y', y)] };
  }

  for (const edge of vertical) consider(edge, undefined);
  for (const edge of horizontal) consider(undefined, edge);
  for (const x of vertical) for (const y of horizontal) consider(x, y);
  return result;
}
