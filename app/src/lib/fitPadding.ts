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

/**
 * Padding that keeps a fitted route out from under map chrome. Each chrome
 * box claims the edge that takes the least of the room still free on that
 * edge's axis, so a box spanning the map's width can only claim the top or
 * bottom, and a second box avoids an axis a first one already loaded. Boxes
 * are placed biggest claim first for that reason. An unmeasurable map falls
 * back to the uniform base; chrome outside the map claims less than the base
 * and so changes nothing.
 */
export function fitPadding(map: Box, chrome: readonly Box[]): FitPadding {
  const pad: FitPadding = {
    top: FIT_PADDING_BASE_PX,
    right: FIT_PADDING_BASE_PX,
    bottom: FIT_PADDING_BASE_PX,
    left: FIT_PADDING_BASE_PX,
  };
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  if (!(width > 0 && height > 0)) return pad;

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
    if (best !== null) pad[best.edge] = Math.max(pad[best.edge], best.need);
  }

  [pad.left, pad.right] = capAxis(pad.left, pad.right, width);
  [pad.top, pad.bottom] = capAxis(pad.top, pad.bottom, height);
  return pad;
}
