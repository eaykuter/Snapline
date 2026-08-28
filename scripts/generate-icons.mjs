import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "public/icons");
const sizes = [16, 32, 48, 128];
const variants = [
  {
    source: resolve(projectRoot, "assets/icons/icon-light.svg"),
    outputName: (size) => `icon-${size}.png`
  },
  {
    source: resolve(projectRoot, "assets/icons/icon-dark.svg"),
    outputName: (size) => `icon-dark-${size}.png`
  }
];

const versionCheck = spawnSync("magick", ["-version"], {
  encoding: "utf8"
});
if (versionCheck.error || versionCheck.status !== 0) {
  throw new Error(
    "ImageMagick is required to regenerate Snapline icons. Install the `magick` command and run `npm run icons` again."
  );
}

mkdirSync(outputDirectory, { recursive: true });

for (const variant of variants) {
  for (const size of sizes) {
    const output = resolve(outputDirectory, variant.outputName(size));
    const result = spawnSync(
      "magick",
      [
        "-background",
        "none",
        variant.source,
        "-filter",
        "Lanczos",
        "-resize",
        `${size}x${size}`,
        "-channel",
        "A",
        "-level",
        "1%,100%",
        "+channel",
        "-colorspace",
        "sRGB",
        "-alpha",
        "on",
        "-depth",
        "8",
        "-strip",
        "-define",
        "png:color-type=6",
        "-define",
        "png:compression-level=9",
        `PNG32:${output}`
      ],
      { encoding: "utf8" }
    );

    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not render ${variant.outputName(size)}: ${
          result.stderr.trim() || result.error?.message || "ImageMagick failed."
        }`
      );
    }

    assertPng(output, size);
  }
}

console.log(`Generated ${variants.length * sizes.length} PNG icons.`);

function assertPng(path, expectedSize) {
  const png = readFileSync(path);
  const signature = png.subarray(0, 8).toString("hex");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];

  if (
    signature !== "89504e470d0a1a0a" ||
    width !== expectedSize ||
    height !== expectedSize ||
    bitDepth !== 8 ||
    colorType !== 6
  ) {
    throw new Error(
      `${path} is not an ${expectedSize}×${expectedSize} 8-bit RGBA PNG.`
    );
  }
}
