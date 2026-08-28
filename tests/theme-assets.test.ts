import { describe, expect, it } from "vitest";
import {
  getActionIconPaths,
  getFaviconPath
} from "../src/theme-assets";

describe("theme assets", () => {
  it("maps every supported size to the light icon set", () => {
    expect(getActionIconPaths("light")).toEqual({
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png"
    });
  });

  it("maps every supported size to the dark icon set", () => {
    expect(getActionIconPaths("dark")).toEqual({
      16: "icons/icon-dark-16.png",
      32: "icons/icon-dark-32.png",
      48: "icons/icon-dark-48.png",
      128: "icons/icon-dark-128.png"
    });
  });

  it("uses the 32-pixel variant for extension page favicons", () => {
    expect(getFaviconPath("light")).toBe("icons/icon-32.png");
    expect(getFaviconPath("dark")).toBe("icons/icon-dark-32.png");
  });
});
