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

function clip(box: Box, to: Box): Box | null {
  const left = Math.max(box.left, to.left);
  const top = Math.max(box.top, to.top);
  const right = Math.min(box.right, to.right);
  const bottom = Math.min(box.bottom, to.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function capAxis(a: number, b: number, extent: number): [number, number] {
  const max = extent * MAX_AXIS_FRACTION;
  const sum = a + b;
  return sum > max ? [(a * max) / sum, (b * max) / sum] : [a, b];
}

/**
 * Padding that keeps a fitted route out from under map chrome. Each chrome
 * box claims the edge it hangs from, on whichever axis costs the map less
 * room. Boxes outside the map, and an unmeasurable map, fall back to the
 * uniform base.
 */
export function fitPadding(map: Box, chrome: readonly Box[]): FitPadding {
  const pad = {
    top: FIT_PADDING_BASE_PX,
    right: FIT_PADDING_BASE_PX,
    bottom: FIT_PADDING_BASE_PX,
    left: FIT_PADDING_BASE_PX,
  };
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  if (!(width > 0 && height > 0)) return pad;

  for (const raw of chrome) {
    const box = clip(raw, map);
    if (box === null) continue;
    if (box.right - box.left < box.bottom - box.top) {
      if (box.left + box.right < map.left + map.right) {
        pad.left = Math.max(pad.left, box.right - map.left + CHROME_GAP_PX);
      } else {
        pad.right = Math.max(pad.right, map.right - box.left + CHROME_GAP_PX);
      }
    } else if (box.top + box.bottom < map.top + map.bottom) {
      pad.top = Math.max(pad.top, box.bottom - map.top + CHROME_GAP_PX);
    } else {
      pad.bottom = Math.max(pad.bottom, map.bottom - box.top + CHROME_GAP_PX);
    }
  }

  [pad.left, pad.right] = capAxis(pad.left, pad.right, width);
  [pad.top, pad.bottom] = capAxis(pad.top, pad.bottom, height);
  return pad;
}
