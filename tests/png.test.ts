import { describe, expect, it } from "vitest";
import {
  crc32,
  readPngDimensions,
  StreamingPngEncoder
} from "../src/png";

describe("streaming PNG encoder", () => {
  it("writes a valid-sized PNG without a full-image canvas", async () => {
    const encoder = new StreamingPngEncoder(2, 2);
    await encoder.writeRows(
      new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255
      ]),
      2
    );

    const blob = await encoder.finish();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe("image/png");
    expect(readPngDimensions(bytes)).toEqual({ width: 2, height: 2 });
    expect(readChunks(bytes).find((chunk) => chunk.type === "sRGB")?.data)
      .toEqual(new Uint8Array([0]));

    const inflated = await inflateIdat(bytes);
    expect(inflated).toEqual(
      new Uint8Array([
        1,
        255, 0, 0, 255,
        1, 255, 0, 0,
        1,
        0, 0, 255, 255,
        255, 255, 0, 0
      ])
    );
  });

  it("rejects incomplete output", async () => {
    const encoder = new StreamingPngEncoder(1, 2);
    await encoder.writeRows(new Uint8ClampedArray([0, 0, 0, 255]), 1);
    await expect(encoder.finish()).rejects.toThrow(
      "expected 2 rows but received 1"
    );
  });

  it("labels Display P3 output before image data", async () => {
    const encoder = new StreamingPngEncoder(1, 1, "display-p3");
    await encoder.writeRows(new Uint8ClampedArray([255, 0, 0, 255]), 1);

    const bytes = new Uint8Array(await (await encoder.finish()).arrayBuffer());
    const chunks = readChunks(bytes);
    const chunkTypes = chunks.map((chunk) => chunk.type);
    expect(chunkTypes.slice(0, 4)).toEqual(["IHDR", "gAMA", "cHRM", "cICP"]);
    expect(chunkTypes.indexOf("cICP")).toBeLessThan(
      chunkTypes.indexOf("IDAT")
    );
    expect(chunkTypes.at(-1)).toBe("IEND");
    expect(chunks.find((chunk) => chunk.type === "cICP")?.data).toEqual(
      new Uint8Array([12, 13, 0, 1])
    );
  });
});

describe("CRC32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

async function inflateIdat(png: Uint8Array): Promise<Uint8Array> {
  const idatParts: Uint8Array[] = [];
  let offset = 8;

  while (offset + 12 <= png.byteLength) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(
      png.subarray(offset + 4, offset + 8)
    );
    if (type === "IDAT") {
      idatParts.push(png.slice(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }

  const stream = new Blob(idatParts.map(toOwnedBuffer))
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readChunks(
  png: Uint8Array
): Array<{ type: string; data: Uint8Array }> {
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  let offset = 8;

  while (offset + 12 <= png.byteLength) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(
      png.subarray(offset + 4, offset + 8)
    );
    chunks.push({
      type,
      data: png.slice(offset + 8, offset + 8 + length)
    });
    offset += 12 + length;
  }

  return chunks;
}

function toOwnedBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
