import type { SelectionRect } from "./types";

export interface BitmapScale {
  x: number;
  y: number;
}

export function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): SelectionRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}

export function getBitmapScale(
  bitmapWidth: number,
  bitmapHeight: number,
  viewportWidth: number,
  viewportHeight: number
): BitmapScale {
  if (
    bitmapWidth <= 0 ||
    bitmapHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    throw new Error("Bitmap and viewport dimensions must be positive.");
  }

  return {
    x: bitmapWidth / viewportWidth,
    y: bitmapHeight / viewportHeight
  };
}

export function rectToBitmap(
  rect: SelectionRect,
  scale: BitmapScale,
  bitmapWidth: number,
  bitmapHeight: number
): SelectionRect {
  const left = clamp(Math.round(rect.x * scale.x), 0, bitmapWidth);
  const top = clamp(Math.round(rect.y * scale.y), 0, bitmapHeight);
  const right = clamp(
    Math.round((rect.x + rect.width) * scale.x),
    left,
    bitmapWidth
  );
  const bottom = clamp(
    Math.round((rect.y + rect.height) * scale.y),
    top,
    bitmapHeight
  );

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

export function buildTilePositions(
  documentHeight: number,
  viewportHeight: number,
  overlap = 64
): number[] {
  if (documentHeight <= 0 || viewportHeight <= 0) {
    throw new Error("Document and viewport heights must be positive.");
  }
  if (overlap < 0) {
    throw new Error("Tile overlap cannot be negative.");
  }

  if (documentHeight <= viewportHeight) {
    return [0];
  }

  const positions: number[] = [];
  const stride = Math.max(1, viewportHeight - Math.min(overlap, viewportHeight - 1));
  let y = 0;

  while (y + viewportHeight < documentHeight) {
    positions.push(y);
    y += stride;
  }

  const finalY = Math.max(0, documentHeight - viewportHeight);
  if (positions.at(-1) !== finalY) {
    positions.push(finalY);
  }

  return positions;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
