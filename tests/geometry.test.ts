import { describe, expect, it } from "vitest";
import {
  buildTilePositions,
  getBitmapScale,
  normalizeRect,
  rectToBitmap
} from "../src/geometry";

describe("selection geometry", () => {
  it("normalizes a reverse-direction drag", () => {
    expect(normalizeRect(90, 70, 20, 15)).toEqual({
      x: 20,
      y: 15,
      width: 70,
      height: 55
    });
  });

  it("clamps a mapped selection to the bitmap bounds", () => {
    expect(
      rectToBitmap(
        { x: -20, y: 30, width: 160, height: 100 },
        { x: 1, y: 1 },
        120,
        80
      )
    ).toEqual({
      x: 0,
      y: 30,
      width: 120,
      height: 50
    });
  });

  it("maps CSS pixels to bitmap pixels at non-integer scale", () => {
    const scale = getBitmapScale(1500, 900, 1000, 600);
    expect(
      rectToBitmap(
        { x: 10.2, y: 20.4, width: 100.4, height: 80.2 },
        scale,
        1500,
        900
      )
    ).toEqual({
      x: 15,
      y: 31,
      width: 151,
      height: 120
    });
  });
});

describe("full-page tile positions", () => {
  it("uses one tile when the page fits in the viewport", () => {
    expect(buildTilePositions(700, 900)).toEqual([0]);
  });

  it("keeps overlap between every adjacent tile", () => {
    expect(buildTilePositions(2500, 1000)).toEqual([0, 936, 1500]);
  });

  it("does not duplicate the exact bottom position", () => {
    expect(buildTilePositions(3000, 1000)).toEqual([0, 936, 1872, 2000]);
  });

  it("allows overlap to be disabled explicitly", () => {
    expect(buildTilePositions(3000, 1000, 0)).toEqual([0, 1000, 2000]);
  });
});
