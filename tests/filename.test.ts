import { describe, expect, it } from "vitest";
import {
  buildFilename,
  getSafeDomain,
  sanitizeFilenamePart
} from "../src/filename";

describe("screenshot filenames", () => {
  it("uses only the domain and local calendar date", () => {
    const date = new Date(2026, 6, 30, 14, 3, 5);
    expect(buildFilename("https://docs.example.com/path", date)).toBe(
      "docs.example.com-20260730.png"
    );
  });

  it("falls back safely for invalid URLs", () => {
    expect(getSafeDomain("not a URL")).toBe("screenshot");
  });

  it("removes unsafe filename characters", () => {
    expect(sanitizeFilenamePart("  My / Demo : Page  ")).toBe(
      "my-demo-page"
    );
  });
});
