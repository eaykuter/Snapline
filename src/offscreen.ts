import { putCapture, pruneCaptures } from "./db";
import { buildFilename } from "./filename";
import { getBitmapScale, rectToBitmap } from "./geometry";
import {
  readPngDimensions,
  StreamingPngEncoder,
  type PngColorSpace
} from "./png";
import type {
  CaptureRecord,
  CommandResult,
  OffscreenCommand,
  ProcessResult,
  ViewportMetrics,
  CaptureSource,
  FullCaptureStatus
} from "./types";

interface FullCaptureState {
  jobId: string;
  metrics: ViewportMetrics;
  source: CaptureSource;
  encoder?: StreamingPngEncoder;
  scaleY?: number;
  outputWidth?: number;
  outputHeight?: number;
  colorSpace?: PngColorSpace;
  writtenRows: number;
  lastRow?: Uint8ClampedArray;
}

const MAX_ROW_ROUNDING_ERROR = 2;

let fullCapture: FullCaptureState | undefined;
let preferredCanvasColorSpace: PngColorSpace | undefined;

void pruneCaptures().catch(() => {
  // Expired temporary data is non-critical and can be retried next launch.
});

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenCommand,
    _sender,
    sendResponse: (
      response: CommandResult<ProcessResult | FullCaptureStatus>
    ) => void
  ) => {
    if (message?.target !== "offscreen") {
      return false;
    }

    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: {
            code: classifyProcessingError(error),
            message: toErrorMessage(error)
          }
        });
      });

    return true;
  }
);

async function handleMessage(
  message: OffscreenCommand
): Promise<CommandResult<ProcessResult | FullCaptureStatus>> {
  switch (message.type) {
    case "PROCESS_STILL":
      return {
        ok: true,
        data: await processStill(message)
      };

    case "FULL_INIT":
      fullCapture = {
        jobId: message.jobId,
        metrics: message.metrics,
        source: message.source,
        writtenRows: 0
      };
      return { ok: true };

    case "FULL_TILE":
      await processFullTile(message.jobId, message.dataUrl, message.y);
      return { ok: true };

    case "FULL_FINISH":
      return {
        ok: true,
        data: await finishFullCapture(message.jobId)
      };

    case "FULL_STATUS":
      return {
        ok: true,
        data: getFullCaptureStatus(message.jobId)
      };

    case "FULL_ABORT":
      if (fullCapture?.jobId === message.jobId) {
        fullCapture = undefined;
      }
      return { ok: true };
  }
}

async function processStill(
  message: Extract<OffscreenCommand, { type: "PROCESS_STILL" }>
): Promise<ProcessResult> {
  const sourceBlob = await dataUrlToBlob(message.dataUrl);

  // Chrome has already produced a complete, lossless PNG for a visible
  // capture. Keeping it intact avoids an unnecessary decode/canvas/encode
  // round-trip that could alter color metadata or quantize converted pixels.
  if (message.mode === "visible") {
    const { width, height } = await readPngBlobDimensions(sourceBlob);
    return await persistCapture({
      blob: sourceBlob,
      width,
      height,
      mode: message.mode,
      source: message.source,
      id: message.jobId
    });
  }

  const bitmap = await createImageBitmap(sourceBlob);

  try {
    let sourceX = 0;
    let sourceY = 0;
    let outputWidth = bitmap.width;
    let outputHeight = bitmap.height;

    if (message.mode === "area") {
      if (!message.rect) {
        throw new Error("The selected area was not provided.");
      }

      const scale = getBitmapScale(
        bitmap.width,
        bitmap.height,
        message.viewport.viewportWidth,
        message.viewport.viewportHeight
      );
      const crop = rectToBitmap(
        message.rect,
        scale,
        bitmap.width,
        bitmap.height
      );
      sourceX = crop.x;
      sourceY = crop.y;
      outputWidth = crop.width;
      outputHeight = crop.height;
    }

    if (outputWidth <= 0 || outputHeight <= 0) {
      throw new Error("The screenshot has no visible pixels.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = getCanvasContext(canvas, getPreferredCanvasColorSpace());
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      outputWidth,
      outputHeight,
      0,
      0,
      outputWidth,
      outputHeight
    );

    const blob = await canvasToPng(canvas);
    return await persistCapture({
      blob,
      width: outputWidth,
      height: outputHeight,
      mode: message.mode,
      source: message.source,
      id: message.jobId
    });
  } finally {
    bitmap.close();
  }
}

async function processFullTile(
  jobId: string,
  dataUrl: string,
  tileY: number
): Promise<void> {
  const state = getFullState(jobId);
  const sourceBlob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    if (!state.encoder) {
      const scale = getBitmapScale(
        bitmap.width,
        bitmap.height,
        state.metrics.viewportWidth,
        state.metrics.viewportHeight
      );
      state.scaleY = scale.y;
      state.outputWidth = Math.max(
        1,
        Math.round(state.metrics.contentWidth * scale.x)
      );
      state.outputHeight = Math.max(
        1,
        Math.round(state.metrics.documentHeight * scale.y)
      );
      state.colorSpace = getPreferredCanvasColorSpace();
      state.encoder = new StreamingPngEncoder(
        state.outputWidth,
        state.outputHeight,
        state.colorSpace
      );
    }

    const scaleY = requireNumber(state.scaleY, "vertical bitmap scale");
    const outputWidth = requireNumber(state.outputWidth, "output width");
    const outputHeight = requireNumber(state.outputHeight, "output height");
    const tileStart = Math.floor(tileY * scaleY + 1e-6);
    const sourceStart = Math.max(0, state.writtenRows - tileStart);

    if (tileStart > state.writtenRows + MAX_ROW_ROUNDING_ERROR) {
      throw new Error("A full-page capture tile left an unexpected gap.");
    }

    const rowsAvailable = Math.max(0, bitmap.height - sourceStart);
    const rowsRemaining = outputHeight - state.writtenRows;
    const rowsToWrite = Math.min(rowsAvailable, rowsRemaining);

    if (rowsToWrite <= 0) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = rowsToWrite;
    const colorSpace = state.colorSpace ?? "srgb";
    const context = getCanvasContext(canvas, colorSpace);
    context.drawImage(
      bitmap,
      0,
      sourceStart,
      outputWidth,
      rowsToWrite,
      0,
      0,
      outputWidth,
      rowsToWrite
    );
    const imageData = context.getImageData(
      0,
      0,
      outputWidth,
      rowsToWrite,
      { colorSpace }
    );
    await state.encoder.writeRows(imageData.data, rowsToWrite);
    state.writtenRows += rowsToWrite;
    const rowBytes = outputWidth * 4;
    state.lastRow = imageData.data.slice(
      imageData.data.byteLength - rowBytes
    );
  } finally {
    bitmap.close();
  }
}

async function finishFullCapture(jobId: string): Promise<ProcessResult> {
  const state = getFullState(jobId);
  const missingRows = (state.outputHeight ?? 0) - state.writtenRows;

  if (
    state.encoder &&
    state.lastRow &&
    missingRows > 0 &&
    missingRows <= MAX_ROW_ROUNDING_ERROR
  ) {
    const padding = new Uint8ClampedArray(state.lastRow.byteLength * missingRows);
    for (let row = 0; row < missingRows; row += 1) {
      padding.set(state.lastRow, row * state.lastRow.byteLength);
    }
    await state.encoder.writeRows(padding, missingRows);
    state.writtenRows += missingRows;
  }

  if (
    !state.encoder ||
    !state.outputWidth ||
    !state.outputHeight ||
    state.writtenRows !== state.outputHeight
  ) {
    throw new Error(
      `Full-page capture is incomplete (${state.writtenRows}/${state.outputHeight ?? 0} rows).`
    );
  }

  try {
    const blob = await state.encoder.finish();
    return await persistCapture({
      id: state.jobId,
      blob,
      width: state.outputWidth,
      height: state.outputHeight,
      mode: "full",
      source: state.source
    });
  } finally {
    fullCapture = undefined;
  }
}

function getFullCaptureStatus(jobId: string): FullCaptureStatus {
  const state = getFullState(jobId);
  const outputHeight = state.outputHeight ?? 0;
  return {
    writtenRows: state.writtenRows,
    outputHeight,
    complete: outputHeight > 0 && state.writtenRows === outputHeight
  };
}

async function persistCapture(
  input: Pick<CaptureRecord, "id" | "blob" | "width" | "height" | "mode" | "source">
): Promise<ProcessResult> {
  const record: CaptureRecord = {
    ...input,
    filename: buildFilename(input.source.url),
    createdAt: Date.now()
  };
  await putCapture(record);

  return {
    captureId: record.id,
    width: record.width,
    height: record.height
  };
}

function getFullState(jobId: string): FullCaptureState {
  if (!fullCapture || fullCapture.jobId !== jobId) {
    throw new Error("The full-page capture session is no longer available.");
  }
  return fullCapture;
}

function getPreferredCanvasColorSpace(): PngColorSpace {
  if (preferredCanvasColorSpace) {
    return preferredCanvasColorSpace;
  }

  const probe = document.createElement("canvas");
  try {
    const context = probe.getContext("2d", {
      alpha: true,
      colorSpace: "display-p3"
    });
    if (context?.getContextAttributes().colorSpace === "display-p3") {
      preferredCanvasColorSpace = "display-p3";
      return preferredCanvasColorSpace;
    }
  } catch {
    // Older Chrome versions ignore or reject the wider canvas color space.
  }

  preferredCanvasColorSpace = "srgb";
  return preferredCanvasColorSpace;
}

function getCanvasContext(
  canvas: HTMLCanvasElement,
  colorSpace: PngColorSpace
): CanvasRenderingContext2D {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d", {
      alpha: true,
      colorSpace,
      willReadFrequently: true
    });
  } catch {
    // The caller receives a structured processing failure below.
  }

  if (!context) {
    throw new Error("Chrome could not create an image-processing canvas.");
  }
  if (context.getContextAttributes().colorSpace !== colorSpace) {
    throw new Error(
      `Chrome could not preserve the requested ${colorSpace} color space.`
    );
  }
  return context;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Chrome could not encode the screenshot as PNG."));
      }
    }, "image/png");
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("Chrome returned unreadable screenshot data.");
  }
  return await response.blob();
}

async function readPngBlobDimensions(
  blob: Blob
): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  return readPngDimensions(bytes);
}

function requireNumber(
  value: number | undefined,
  description: string
): number {
  if (value === undefined) {
    throw new Error(`Missing ${description}.`);
  }
  return value;
}

function classifyProcessingError(
  error: unknown
): "RESOURCE_EXHAUSTED" | "PROCESSING_FAILED" {
  const message = toErrorMessage(error).toLowerCase();
  return /memory|allocation|too large|resource|canvas/.test(message)
    ? "RESOURCE_EXHAUSTED"
    : "PROCESSING_FAILED";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Screenshot processing failed unexpectedly.";
}
