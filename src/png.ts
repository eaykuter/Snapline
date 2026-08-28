const PNG_SIGNATURE = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10
]);
const MAX_IDAT_CHUNK_SIZE = 1024 * 1024;
const BYTES_PER_PIXEL = 4;

export type PngColorSpace = "display-p3" | "srgb";

export class StreamingPngEncoder {
  readonly width: number;
  readonly height: number;
  readonly colorSpace: PngColorSpace;

  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly compressedParts: Uint8Array[] = [];
  private readonly pumpPromise: Promise<void>;
  private writtenRows = 0;
  private finished = false;

  constructor(
    width: number,
    height: number,
    colorSpace: PngColorSpace = "srgb"
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error("PNG dimensions must be integers.");
    }
    if (width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
      throw new Error("PNG dimensions are outside the supported range.");
    }

    this.width = width;
    this.height = height;
    this.colorSpace = colorSpace;

    const compression = new CompressionStream("deflate");
    this.writer = compression.writable.getWriter();
    this.pumpPromise = this.collectCompressedData(compression.readable);
  }

  async writeRows(rgba: Uint8ClampedArray, rowCount: number): Promise<void> {
    if (this.finished) {
      throw new Error("Cannot add rows after the PNG encoder is finished.");
    }
    if (!Number.isInteger(rowCount) || rowCount <= 0) {
      throw new Error("PNG row count must be a positive integer.");
    }
    if (this.writtenRows + rowCount > this.height) {
      throw new Error("PNG encoder received more rows than expected.");
    }

    const bytesPerRow = this.width * BYTES_PER_PIXEL;
    if (rgba.byteLength !== bytesPerRow * rowCount) {
      throw new Error("RGBA row data does not match the PNG dimensions.");
    }

    const filtered = new Uint8Array((bytesPerRow + 1) * rowCount);

    for (let row = 0; row < rowCount; row += 1) {
      const inputOffset = row * bytesPerRow;
      const outputOffset = row * (bytesPerRow + 1);
      filtered[outputOffset] = 1;

      for (let byte = 0; byte < bytesPerRow; byte += 1) {
        const current = rgba[inputOffset + byte] ?? 0;
        const left =
          byte >= BYTES_PER_PIXEL
            ? (rgba[inputOffset + byte - BYTES_PER_PIXEL] ?? 0)
            : 0;
        filtered[outputOffset + 1 + byte] = (current - left + 256) & 0xff;
      }
    }

    await this.writer.write(filtered);
    this.writtenRows += rowCount;
  }

  async finish(): Promise<Blob> {
    if (this.finished) {
      throw new Error("PNG encoder has already been finished.");
    }
    if (this.writtenRows !== this.height) {
      throw new Error(
        `PNG encoder expected ${this.height} rows but received ${this.writtenRows}.`
      );
    }

    this.finished = true;
    await this.writer.close();
    await this.pumpPromise;

    const parts: BlobPart[] = [
      toOwnedBuffer(PNG_SIGNATURE),
      toOwnedBuffer(createChunk("IHDR", createHeader(this.width, this.height))),
      ...createColorSpaceChunks(this.colorSpace).map(toOwnedBuffer)
    ];

    for (const compressed of this.compressedParts) {
      for (
        let offset = 0;
        offset < compressed.byteLength;
        offset += MAX_IDAT_CHUNK_SIZE
      ) {
        parts.push(
          toOwnedBuffer(createChunk(
            "IDAT",
            compressed.subarray(
              offset,
              Math.min(offset + MAX_IDAT_CHUNK_SIZE, compressed.byteLength)
            )
          ))
        );
      }
    }

    parts.push(toOwnedBuffer(createChunk("IEND", new Uint8Array())));
    return new Blob(parts, { type: "image/png" });
  }

  private async collectCompressedData(
    stream: ReadableStream<Uint8Array>
  ): Promise<void> {
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value && value.byteLength > 0) {
        this.compressedParts.push(value);
      }
    }
  }
}

export function createChunk(type: string, data: Uint8Array): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(type)) {
    throw new Error("PNG chunk type must contain exactly four ASCII letters.");
  }

  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);

  const checksumInput = chunk.subarray(4, 8 + data.byteLength);
  view.setUint32(8 + data.byteLength, crc32(checksumInput));
  return chunk;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function readPngDimensions(
  bytes: Uint8Array
): { width: number; height: number } {
  if (bytes.byteLength < 24) {
    throw new Error("PNG data is incomplete.");
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error("PNG signature is invalid.");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20)
  };
}

function createHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return header;
}

function createColorSpaceChunks(colorSpace: PngColorSpace): Uint8Array[] {
  if (colorSpace === "srgb") {
    return [createChunk("sRGB", new Uint8Array([0]))];
  }

  return [
    createChunk("gAMA", uint32Data(45_455)),
    createChunk(
      "cHRM",
      uint32ListData([
        31_270,
        32_900,
        68_000,
        32_000,
        26_500,
        69_000,
        15_000,
        6_000
      ])
    ),
    createChunk("cICP", new Uint8Array([12, 13, 0, 1]))
  ];
}

function uint32Data(value: number): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value);
  return data;
}

function uint32ListData(values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  const view = new DataView(data.buffer);
  values.forEach((value, index) => {
    view.setUint32(index * 4, value);
  });
  return data;
}

function toOwnedBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
