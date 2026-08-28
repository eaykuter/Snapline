export type CaptureMode = "area" | "visible" | "full";

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportMetrics {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  documentHeight: number;
}

export interface CaptureSource {
  tabId: number;
  url: string;
}

export interface CaptureRecord {
  id: string;
  blob: Blob;
  filename: string;
  mode: CaptureMode;
  source: CaptureSource;
  previewTabId?: number;
  width: number;
  height: number;
  createdAt: number;
}

export interface FullCaptureStatus {
  writtenRows: number;
  outputHeight: number;
  complete: boolean;
}

export type CaptureErrorCode =
  | "BUSY"
  | "PROTECTED_PAGE"
  | "TAB_CLOSED"
  | "TAB_NAVIGATED"
  | "CAPTURE_FAILED"
  | "PROCESSING_FAILED"
  | "CLIPBOARD_FAILED"
  | "CANCELLED"
  | "INVALID_SELECTION"
  | "RESOURCE_EXHAUSTED"
  | "UNKNOWN";

export interface CaptureError {
  code: CaptureErrorCode;
  message: string;
}

export interface StartCaptureMessage {
  target: "background";
  type: "START_CAPTURE";
  mode: CaptureMode;
  tabId?: number;
}

export type FullCaptureProgressPhase =
  | "preparing"
  | "capturing"
  | "encoding"
  | "complete"
  | "cancelled"
  | "error";

export interface FullCaptureProgressMessage {
  target: "popup";
  type: "FULL_CAPTURE_PROGRESS";
  jobId: string;
  phase: FullCaptureProgressPhase;
  current?: number;
  total?: number;
  message?: string;
}

export type StillCaptureProgressPhase = "capturing" | "processing" | "error";

export interface StillCaptureProgressMessage {
  target: "popup";
  type: "STILL_CAPTURE_PROGRESS";
  jobId: string;
  mode: "area" | "visible";
  phase: StillCaptureProgressPhase;
  message?: string;
}

export interface AreaSelectedMessage {
  target: "background";
  type: "AREA_SELECTED";
  rect: SelectionRect;
  viewport: Pick<ViewportMetrics, "viewportWidth" | "viewportHeight">;
}

export interface FullCancelledMessage {
  target: "background";
  type: "FULL_CANCELLED";
  jobId: string;
}

export interface CancelActiveFullMessage {
  target: "background";
  type: "CANCEL_ACTIVE_FULL";
}

export interface GetActiveFullProgressMessage {
  target: "background";
  type: "GET_ACTIVE_FULL_PROGRESS";
}

export interface GetActiveStillProgressMessage {
  target: "background";
  type: "GET_ACTIVE_STILL_PROGRESS";
}

export type BackgroundInboundMessage =
  | StartCaptureMessage
  | AreaSelectedMessage
  | FullCancelledMessage
  | CancelActiveFullMessage
  | GetActiveFullProgressMessage
  | GetActiveStillProgressMessage;

export type ContentCommand =
  | { target: "content"; type: "PING" }
  | { target: "content"; type: "START_AREA" }
  | { target: "content"; type: "CANCEL_AREA" }
  | { target: "content"; type: "READ_VIEWPORT" }
  | { target: "content"; type: "PREPARE_FULL"; jobId: string }
  | {
      target: "content";
      type: "SCROLL_FULL";
      jobId: string;
      y: number;
      tileIndex: number;
      tileCount: number;
    }
  | { target: "content"; type: "RESTORE_FULL"; jobId: string };

export type OffscreenCommand =
  | {
      target: "offscreen";
      type: "PROCESS_STILL";
      jobId: string;
      mode: "area" | "visible";
      dataUrl: string;
      rect?: SelectionRect;
      viewport: Pick<ViewportMetrics, "viewportWidth" | "viewportHeight">;
      source: CaptureSource;
    }
  | {
      target: "offscreen";
      type: "FULL_INIT";
      jobId: string;
      metrics: ViewportMetrics;
      source: CaptureSource;
    }
  | {
      target: "offscreen";
      type: "FULL_TILE";
      jobId: string;
      dataUrl: string;
      y: number;
    }
  | {
      target: "offscreen";
      type: "FULL_FINISH";
      jobId: string;
    }
  | {
      target: "offscreen";
      type: "FULL_STATUS";
      jobId: string;
    }
  | {
      target: "offscreen";
      type: "FULL_ABORT";
      jobId: string;
    };

export interface ProcessResult {
  captureId: string;
  width: number;
  height: number;
}

export interface CommandSuccess<T = undefined> {
  ok: true;
  data?: T;
}

export interface CommandFailure {
  ok: false;
  error: CaptureError;
}

export type CommandResult<T = undefined> =
  | CommandSuccess<T>
  | CommandFailure;
