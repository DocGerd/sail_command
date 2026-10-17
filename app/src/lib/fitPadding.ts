export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const FIT_PADDING_BASE_PX = 48;

const CHROME_GAP_PX = 16;
const LABEL_CLEARANCE_PX = 8;
const MAX_AXIS_FRACTION = 0.7;

// Only the excess over the base is scaled, so a capped edge never drops below
// the base and a lone claim keeps the opposite edge at the base.
function capAxis(a: number, b: number, extent: number): [number, number] {
  const room = extent * MAX_AXIS_FRACTION - 2 * FIT_PADDING_BASE_PX;
  const excessA = a - FIT_PADDING_BASE_PX;
  const excessB = b - FIT_PADDING_BASE_PX;
  const excess = excessA + excessB;
  if (excess <= room) return [a, b];
  const scale = Math.max(room, 0) / excess;
  return [FIT_PADDING_BASE_PX + excessA * scale, FIT_PADDING_BASE_PX + excessB * scale];
}

type Edge = keyof FitPadding;

interface Claim {
  edge: Edge;
  px: number;
}

function claimsOf(box: Box, map: Box): Claim[] {
  return [
    { edge: 'left', px: box.right - map.left },
    { edge: 'right', px: map.right - box.left },
    { edge: 'top', px: box.bottom - map.top },
    { edge: 'bottom', px: map.bottom - box.top },
  ];
}

interface Placement {
  pad: FitPadding;
  // Distance from the map edge to the chrome that claimed it; 0 when unclaimed.
  reach: FitPadding;
}

function place(map: Box, chrome: readonly Box[]): Placement {
  const pad: FitPadding = {
    top: FIT_PADDING_BASE_PX,
    right: FIT_PADDING_BASE_PX,
    bottom: FIT_PADDING_BASE_PX,
    left: FIT_PADDING_BASE_PX,
  };
  const reach: FitPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  if (!(width > 0 && height > 0)) return { pad, reach };

  const extentOf = (edge: Edge) => (edge === 'left' || edge === 'right' ? width : height);
  const smallestShare = (box: Box) =>
    Math.min(...claimsOf(box, map).map((c) => c.px / extentOf(c.edge)));
  const biggestFirst = [...chrome].sort((a, b) => smallestShare(b) - smallestShare(a));

  for (const box of biggestFirst) {
    let best: { edge: Edge; need: number; cost: number } | null = null;
    for (const { edge, px } of claimsOf(box, map)) {
      const need = px + CHROME_GAP_PX;
      const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[edge] as Edge;
      const free = Math.max(extentOf(edge) - pad[edge] - pad[opposite], 1);
      const cost = Math.max(0, need - pad[edge]) / free;
      if (best === null || cost < best.cost) best = { edge, need, cost };
    }
    if (best !== null) {
      pad[best.edge] = Math.max(pad[best.edge], best.need);
      reach[best.edge] = Math.max(reach[best.edge], best.need - CHROME_GAP_PX);
    }
  }
  return { pad, reach };
}

const NO_EXTRA: FitPadding = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * How far each label rect pokes past the room a fit leaves it: clear of the
 * chrome that claimed an edge, or of the map edge when none did. Rects are in
 * the same coordinates as `map`.
 */
export function labelOverhang(
  map: Box,
  chrome: readonly Box[],
  labels: readonly Box[],
): FitPadding {
  const out: FitPadding = { ...NO_EXTRA };
  if (!(map.right > map.left && map.bottom > map.top)) return out;
  const { reach } = place(map, chrome);
  const room = (edge: Edge) => reach[edge] + LABEL_CLEARANCE_PX;
  for (const l of labels) {
    out.left = Math.max(out.left, room('left') - (l.left - map.left));
    out.right = Math.max(out.right, room('right') - (map.right - l.right));
    out.top = Math.max(out.top, room('top') - (l.top - map.top));
    out.bottom = Math.max(out.bottom, room('bottom') - (map.bottom - l.bottom));
  }
  return out;
}

/**
 * Padding that keeps a fitted route out from under map chrome. Each chrome
 * box claims the edge that takes the least of the room still free on that
 * edge's axis, so a box spanning the map's width can only claim the top or
 * bottom, and a second box avoids an axis a first one already loaded. Boxes
 * are placed biggest claim first for that reason. An unmeasurable map falls
 * back to the uniform base; chrome outside the map claims less than the base
 * and so changes nothing.
 */
export function fitPadding(
  map: Box,
  chrome: readonly Box[],
  extra: FitPadding = NO_EXTRA,
): FitPadding {
  const { pad } = place(map, chrome);
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  if (!(width > 0 && height > 0)) return pad;
  pad.left += extra.left;
  pad.right += extra.right;
  pad.top += extra.top;
  pad.bottom += extra.bottom;
  [pad.left, pad.right] = capAxis(pad.left, pad.right, width);
  [pad.top, pad.bottom] = capAxis(pad.top, pad.bottom, height);
  return pad;
}
