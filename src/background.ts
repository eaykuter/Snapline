import { buildTilePositions } from "./geometry";
import { readPngDimensions } from "./png";
import {
  sendOffscreen,
  withOffscreenDocument
} from "./offscreen-client";
import {
  attachCaptureToPreview,
  deleteCapturesForPreviewTab,
  deleteOrphanedPreviewCaptures
} from "./db";
import type {
  BackgroundInboundMessage,
  CaptureError,
  CaptureMode,
  CaptureSource,
  CommandResult,
  ContentCommand,
  FullCaptureProgressMessage,
  FullCaptureStatus,
  OffscreenCommand,
  ProcessResult,
  SelectionRect,
  StillCaptureProgressMessage,
  ViewportMetrics
} from "./types";

type CaptureProgressMessage =
  | FullCaptureProgressMessage
  | StillCaptureProgressMessage;

interface ActiveCaptureProgress<T extends CaptureProgressMessage> {
  jobId: string;
  tabId: number;
  badgeUpdate: Promise<void>;
  latestProgress?: T;
}

interface ActiveFullCapture
  extends ActiveCaptureProgress<FullCaptureProgressMessage> {
  cancelled: boolean;
}

interface ActiveStillCapture
  extends ActiveCaptureProgress<StillCaptureProgressMessage> {
  mode: "area" | "visible";
}

// Chrome allows at most two captureVisibleTab calls per second. A small margin
// above the 500 ms boundary avoids rate-limit jitter without slowing the pass.
const CAPTURE_INTERVAL_MS = 525;
const MAX_ROW_ROUNDING_ERROR = 2;
const TAB_ACTIVATION_ATTEMPTS = 8;
const TAB_ACTIVATION_CONFIRMATION_MS = 50;
const TAB_ACTIVATION_RETRY_MS = 40;
let activeFullCapture: ActiveFullCapture | undefined;
let activeStillCapture: ActiveStillCapture | undefined;
let lastCaptureStartedAt = 0;
let captureQueue: Promise<void> = Promise.resolve();

chrome.tabs.onRemoved.addListener((tabId) => {
  void ignoreFailure(deleteCapturesForPreviewTab(tabId));
});

void ignoreFailure(cleanOrphanedPreviewCaptures());

chrome.commands.onCommand.addListener((command) => {
  const modeByCommand: Record<string, CaptureMode> = {
    "capture-area": "area",
    "capture-visible": "visible",
    "capture-full": "full"
  };
  const mode = modeByCommand[command];
  if (mode) {
    void startCapture(mode).catch((error: unknown) => {
      void openErrorPreview(toCaptureError(error));
    });
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundInboundMessage,
    sender,
    sendResponse: (
      response: CommandResult<
        FullCaptureProgressMessage | StillCaptureProgressMessage
      >
    ) => void
  ) => {
    if (message?.target !== "background") {
      return false;
    }

    if (message.type === "FULL_CANCELLED") {
      if (activeFullCapture?.jobId === message.jobId) {
        activeFullCapture.cancelled = true;
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "CANCEL_ACTIVE_FULL") {
      if (activeFullCapture) {
        activeFullCapture.cancelled = true;
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "GET_ACTIVE_FULL_PROGRESS") {
      sendResponse({
        ok: true,
        data: activeFullCapture?.latestProgress
      });
      return false;
    }

    if (message.type === "GET_ACTIVE_STILL_PROGRESS") {
      sendResponse({
        ok: true,
        data: activeStillCapture?.latestProgress
      });
      return false;
    }

    if (message.type === "AREA_SELECTED") {
      const tab = sender.tab;
      if (!tab?.id || tab.windowId === undefined) {
        sendResponse({
          ok: false,
          error: {
            code: "TAB_CLOSED",
            message: "The source tab is no longer available."
          }
        });
        return false;
      }

      void finishAreaCapture(tab, message.rect, message.viewport)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          const captureError = toCaptureError(error);
          void openErrorPreview(captureError);
          sendResponse({ ok: false, error: captureError });
        });
      return true;
    }

    void startCapture(message.mode, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        const captureError = toCaptureError(error);
        sendResponse({ ok: false, error: captureError });
      });
    return true;
  }
);

async function startCapture(
  mode: CaptureMode,
  requestedTabId?: number
): Promise<void> {
  if (activeFullCapture || activeStillCapture) {
    throw captureError("BUSY", "A screenshot is already in progress.");
  }

  const tab = await getSourceTab(requestedTabId);
  const source = toSource(tab);
  const tabId = source.tabId;

  if (mode !== "area") {
    await cancelAreaOverlay(tabId);
  }

  if (mode === "area") {
    await injectContentScript(tabId);
    const response = await sendContent(tabId, {
      target: "content",
      type: "START_AREA"
    });
    assertSuccess(response);
    return;
  }

  if (mode === "visible") {
    await runStillCapture(tab, source, "visible");
    return;
  }

  const jobId = crypto.randomUUID();
  activeFullCapture = {
    jobId,
    tabId,
    cancelled: false,
    badgeUpdate: Promise.resolve()
  };
  await publishFullProgress({
    target: "popup",
    type: "FULL_CAPTURE_PROGRESS",
    jobId,
    phase: "preparing"
  });
  void withOffscreenDocument(() => runFullCapture(tab, source, jobId));
}

async function finishAreaCapture(
  tab: chrome.tabs.Tab,
  rect: SelectionRect,
  viewport: { viewportWidth: number; viewportHeight: number }
): Promise<void> {
  const source = toSource(tab);
  await runStillCapture(tab, source, "area", { rect, viewport });
}

async function runStillCapture(
  tab: chrome.tabs.Tab,
  source: CaptureSource,
  mode: "area" | "visible",
  options: {
    rect?: SelectionRect;
    viewport?: Pick<ViewportMetrics, "viewportWidth" | "viewportHeight">;
  } = {}
): Promise<void> {
  if (tab.id === undefined || tab.windowId === undefined) {
    throw captureError("TAB_CLOSED", "The source tab is unavailable.");
  }
  if (activeFullCapture || activeStillCapture) {
    throw captureError("BUSY", "A screenshot is already in progress.");
  }

  const jobId = crypto.randomUUID();
  activeStillCapture = {
    jobId,
    tabId: tab.id,
    mode,
    badgeUpdate: Promise.resolve()
  };

  try {
    await publishStillProgress({
      target: "popup",
      type: "STILL_CAPTURE_PROGRESS",
      jobId,
      mode,
      phase: "capturing"
    });
    const dataUrl = await captureVisible(tab.windowId);
    const viewport =
      options.viewport ?? (await readViewportOrFallback(tab.id, dataUrl));
    await publishStillProgress({
      target: "popup",
      type: "STILL_CAPTURE_PROGRESS",
      jobId,
      mode,
      phase: "processing"
    });
    const processed = await processStill({
      target: "offscreen",
      type: "PROCESS_STILL",
      jobId,
      mode,
      dataUrl,
      rect: options.rect,
      viewport,
      source
    });
    await openPreview(processed.captureId);
  } catch (error: unknown) {
    const resolvedError = toCaptureError(error);
    await publishStillProgress({
      target: "popup",
      type: "STILL_CAPTURE_PROGRESS",
      jobId,
      mode,
      phase: "error",
      message: resolvedError.message
    });
    throw error;
  } finally {
    await finishStillCapture(tab.id, jobId);
  }
}

async function runFullCapture(
  tab: chrome.tabs.Tab,
  source: CaptureSource,
  jobId: string
): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined || tab.windowId === undefined) {
    activeFullCapture = undefined;
    return;
  }

  let initialized = false;
  try {
    await injectContentScript(tabId);
    const prepared = await sendContent<ViewportMetrics>(tabId, {
      target: "content",
      type: "PREPARE_FULL",
      jobId
    });
    assertNotCancelled(jobId);
    const metrics = assertSuccess(prepared);
    const positions = buildTilePositions(
      metrics.documentHeight,
      metrics.viewportHeight
    );

    assertNotCancelled(jobId);
    assertPageUnchanged(await chrome.tabs.get(tabId), source.url);
    assertSuccess(
      await sendOffscreen({
        target: "offscreen",
        type: "FULL_INIT",
        jobId,
        metrics,
        source
      })
    );
    initialized = true;

    for (let index = 0; index < positions.length; index += 1) {
      assertNotCancelled(jobId);
      assertPageUnchanged(await chrome.tabs.get(tabId), source.url);
      await publishFullProgress({
        target: "popup",
        type: "FULL_CAPTURE_PROGRESS",
        jobId,
        phase: "capturing",
        current: index + 1,
        total: positions.length
      });

      const y = positions[index] ?? 0;
      const scrolled = await sendContent<{ actualY: number }>(tabId, {
        target: "content",
        type: "SCROLL_FULL",
        jobId,
        y,
        tileIndex: index,
        tileCount: positions.length
      });
      assertNotCancelled(jobId);
      const { actualY } = assertSuccess(scrolled);

      assertNotCancelled(jobId);
      const dataUrl = await captureVisible(tab.windowId);
      assertNotCancelled(jobId);
      assertSuccess(
        await sendOffscreen({
          target: "offscreen",
          type: "FULL_TILE",
          jobId,
          dataUrl,
          y: actualY
        })
      );
    }

    assertNotCancelled(jobId);
    let status = assertSuccess(
      await sendOffscreen<FullCaptureStatus>({
        target: "offscreen",
        type: "FULL_STATUS",
        jobId
      })
    );

    const missingRows = status.outputHeight - status.writtenRows;
    if (!status.complete && missingRows > MAX_ROW_ROUNDING_ERROR) {
      const recoveryIndex = positions.length;
      await publishFullProgress({
        target: "popup",
        type: "FULL_CAPTURE_PROGRESS",
        jobId,
        phase: "capturing",
        current: positions.length + 1,
        total: positions.length + 1
      });
      const scrolled = await sendContent<{ actualY: number }>(tabId, {
        target: "content",
        type: "SCROLL_FULL",
        jobId,
        y: metrics.documentHeight,
        tileIndex: recoveryIndex,
        tileCount: positions.length + 1
      });
      assertNotCancelled(jobId);
      const { actualY } = assertSuccess(scrolled);

      assertNotCancelled(jobId);
      assertPageUnchanged(await chrome.tabs.get(tabId), source.url);
      const dataUrl = await captureVisible(tab.windowId);
      assertSuccess(
        await sendOffscreen({
          target: "offscreen",
          type: "FULL_TILE",
          jobId,
          dataUrl,
          y: actualY
        })
      );
      status = assertSuccess(
        await sendOffscreen<FullCaptureStatus>({
          target: "offscreen",
          type: "FULL_STATUS",
          jobId
        })
      );
    }

    if (
      !status.complete &&
      status.outputHeight - status.writtenRows > MAX_ROW_ROUNDING_ERROR
    ) {
      throw captureError(
        "PROCESSING_FAILED",
        "The page changed size while it was being captured. The page was restored and no partial image was saved."
      );
    }

    await publishFullProgress({
      target: "popup",
      type: "FULL_CAPTURE_PROGRESS",
      jobId,
      phase: "encoding"
    });
    const finished = await sendOffscreen({
      target: "offscreen",
      type: "FULL_FINISH",
      jobId
    });
    const processed = assertSuccess(finished);
    await publishFullProgress({
      target: "popup",
      type: "FULL_CAPTURE_PROGRESS",
      jobId,
      phase: "complete"
    });
    await openPreview(processed.captureId);
  } catch (error: unknown) {
    if (initialized) {
      await ignoreFailure(sendOffscreen({
        target: "offscreen",
        type: "FULL_ABORT",
        jobId
      }));
    }

    const resolvedError = toCaptureError(error);
    if (resolvedError.code === "CANCELLED") {
      await publishFullProgress({
        target: "popup",
        type: "FULL_CAPTURE_PROGRESS",
        jobId,
        phase: "cancelled"
      });
    } else {
      await publishFullProgress({
        target: "popup",
        type: "FULL_CAPTURE_PROGRESS",
        jobId,
        phase: "error",
        message: resolvedError.message
      });
      await openErrorPreview(resolvedError);
    }
  } finally {
    await ignoreFailure(sendContent(tabId, {
      target: "content",
      type: "RESTORE_FULL",
      jobId
    }));
    if (activeFullCapture) {
      await ignoreFailure(activeFullCapture.badgeUpdate);
    }
    await clearCaptureBadge(tabId);
    if (activeFullCapture?.jobId === jobId) {
      activeFullCapture = undefined;
    }
  }
}

async function publishCaptureProgress<T extends CaptureProgressMessage>(
  message: T,
  capture: ActiveCaptureProgress<T> | undefined,
  updateBadge: (tabId: number, message: T) => Promise<void>
): Promise<void> {
  if (!capture || capture.jobId !== message.jobId) {
    return;
  }

  capture.latestProgress = message;
  capture.badgeUpdate = ignoreFailure(capture.badgeUpdate)
    .then(() => updateBadge(capture.tabId, message));
  await Promise.all([
    capture.badgeUpdate,
    ignoreFailure(chrome.runtime.sendMessage(message))
  ]);
}

async function publishFullProgress(
  message: FullCaptureProgressMessage
): Promise<void> {
  return publishCaptureProgress(
    message,
    activeFullCapture,
    updateFullCaptureBadge
  );
}

async function publishStillProgress(
  message: StillCaptureProgressMessage
): Promise<void> {
  return publishCaptureProgress(
    message,
    activeStillCapture,
    updateStillCaptureBadge
  );
}

async function updateFullCaptureBadge(
  tabId: number,
  message: FullCaptureProgressMessage
): Promise<void> {
  let badgeText = "…";
  let title = "Snapline is preparing a full-page screenshot";

  if (message.phase === "capturing") {
    const current = message.current ?? 1;
    const total = Math.max(current, message.total ?? current);
    const percentage = Math.round((current / total) * 100);
    badgeText =
      current <= 9 && total <= 9
        ? `${current}/${total}`
        : `${percentage}%`;
    title = `Snapline is capturing ${current} of ${total}`;
  } else if (message.phase === "encoding") {
    title = "Snapline is finishing the screenshot";
  } else if (message.phase === "complete") {
    badgeText = "✓";
    title = "Snapline screenshot ready";
  } else if (message.phase === "error") {
    badgeText = "!";
    title = message.message ?? "Snapline capture failed";
  } else if (message.phase === "cancelled") {
    badgeText = "";
    title = "Capture a screenshot";
  }

  await setCaptureBadge(tabId, badgeText, title);
}

async function updateStillCaptureBadge(
  tabId: number,
  message: StillCaptureProgressMessage
): Promise<void> {
  const subject = message.mode === "area" ? "selected area" : "visible page";
  const phaseLabel =
    message.phase === "processing" ? "processing" : "capturing";
  const title =
    message.phase === "error"
      ? message.message ?? "Snapline capture failed"
      : `Snapline is ${phaseLabel} the ${subject}`;
  await setCaptureBadge(
    tabId,
    message.phase === "error" ? "!" : "…",
    title
  );
}

async function finishStillCapture(tabId: number, jobId: string): Promise<void> {
  const capture = activeStillCapture;
  if (!capture || capture.jobId !== jobId) {
    return;
  }
  await ignoreFailure(capture.badgeUpdate);
  await clearCaptureBadge(tabId);
  if (activeStillCapture?.jobId === jobId) {
    activeStillCapture = undefined;
  }
}

async function clearCaptureBadge(tabId: number): Promise<void> {
  await ignoreFailure(setCaptureBadge(tabId, "", "Capture a screenshot"));
}

async function setCaptureBadge(
  tabId: number,
  text: string,
  title: string
): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" }),
    chrome.action.setTitle({ tabId, title })
  ]);
}

async function getSourceTab(requestedTabId?: number): Promise<chrome.tabs.Tab> {
  if (requestedTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(requestedTabId);
      if (tab.id !== undefined) {
        return await activateSourceTab(tab);
      }
    } catch {
      throw captureError("TAB_CLOSED", "The original tab is no longer available.");
    }
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) {
    throw captureError("TAB_CLOSED", "No active browser tab was found.");
  }
  return tab;
}

async function activateSourceTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab> {
  if (tab.id === undefined || tab.windowId === undefined) {
    throw captureError("TAB_CLOSED", "The original tab is no longer available.");
  }

  try {
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }

    for (let attempt = 0; attempt < TAB_ACTIVATION_ATTEMPTS; attempt += 1) {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        windowId: tab.windowId
      });
      if (activeTab?.id === tab.id) {
        await delay(TAB_ACTIVATION_CONFIRMATION_MS);
        return await chrome.tabs.get(tab.id);
      }
      await delay(TAB_ACTIVATION_RETRY_MS);
    }
  } catch {
    throw captureError("TAB_CLOSED", "The original tab is no longer available.");
  }

  throw captureError(
    "CAPTURE_FAILED",
    "Chrome could not reactivate the original tab for this retake."
  );
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: "PING"
    });
    if (response?.ok) {
      return;
    }
  } catch {
    // No content script is installed in this tab yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch {
    throw captureError(
      "PROTECTED_PAGE",
      "Area and full-page capture are unavailable on this protected Chrome page."
    );
  }
}

async function cancelAreaOverlay(tabId: number): Promise<void> {
  await ignoreFailure(sendContent(tabId, {
    target: "content",
    type: "CANCEL_AREA"
  }));
}

async function readViewportOrFallback(
  tabId: number,
  dataUrl: string
): Promise<{ viewportWidth: number; viewportHeight: number }> {
  try {
    await injectContentScript(tabId);
    const result = await chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: "READ_VIEWPORT"
    });
    if (
      result?.ok &&
      result.data?.viewportWidth > 0 &&
      result.data?.viewportHeight > 0
    ) {
      return result.data;
    }
  } catch {
    // Visible capture can still succeed on pages that reject content scripts.
  }

  const dimensions = await readDataUrlDimensions(dataUrl);
  return {
    viewportWidth: dimensions.width,
    viewportHeight: dimensions.height
  };
}

async function readDataUrlDimensions(
  dataUrl: string
): Promise<{ width: number; height: number }> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.size < 24) {
    throw captureError("CAPTURE_FAILED", "Chrome returned invalid screenshot data.");
  }
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  return readPngDimensions(bytes);
}

async function captureVisible(windowId: number): Promise<string> {
  const result = ignoreFailure(captureQueue)
    .then(async () => {
      const elapsed = Date.now() - lastCaptureStartedAt;
      if (lastCaptureStartedAt > 0 && elapsed < CAPTURE_INTERVAL_MS) {
        await delay(CAPTURE_INTERVAL_MS - elapsed);
      }

      lastCaptureStartedAt = Date.now();
      try {
        return await chrome.tabs.captureVisibleTab(windowId, {
          format: "png"
        });
      } catch {
        throw captureError(
          "CAPTURE_FAILED",
          "Chrome could not capture the visible tab. Try focusing the page and capture again."
        );
      }
    });

  captureQueue = result.then(
    () => undefined,
    () => undefined
  );
  return await result;
}

async function processStill(
  message: Extract<OffscreenCommand, { type: "PROCESS_STILL" }>
): Promise<ProcessResult> {
  return await withOffscreenDocument(async () => {
    return assertSuccess(await sendOffscreen(message));
  });
}

async function sendContent<T = undefined>(
  tabId: number,
  message: ContentCommand
): Promise<CommandResult<T>> {
  return (await chrome.tabs.sendMessage(tabId, message)) as CommandResult<T>;
}

async function openPreview(captureId: string): Promise<void> {
  const previewTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(captureId)}`)
  });
  if (previewTab.id === undefined) {
    throw captureError("TAB_CLOSED", "Chrome could not open the screenshot preview.");
  }
  await attachCaptureToPreview(captureId, previewTab.id);
}

async function openErrorPreview(error: CaptureError): Promise<void> {
  const params = new URLSearchParams({
    error: error.message,
    code: error.code
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?${params.toString()}`)
  });
}

async function cleanOrphanedPreviewCaptures(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const liveTabIds = new Set(
    tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
  );
  await deleteOrphanedPreviewCaptures(liveTabIds);
}

function toSource(tab: chrome.tabs.Tab): CaptureSource {
  if (tab.id === undefined) {
    throw captureError("TAB_CLOSED", "The source tab is unavailable.");
  }
  return {
    tabId: tab.id,
    url: tab.url ?? "about:blank"
  };
}

function assertPageUnchanged(tab: chrome.tabs.Tab, expectedUrl: string): void {
  if (!tab.id) {
    throw captureError("TAB_CLOSED", "The source tab was closed during capture.");
  }
  if ((tab.url ?? "") !== expectedUrl) {
    throw captureError(
      "TAB_NAVIGATED",
      "The page changed during full-page capture. Nothing was saved."
    );
  }
}

function assertNotCancelled(jobId: string): void {
  if (
    !activeFullCapture ||
    activeFullCapture.jobId !== jobId ||
    activeFullCapture.cancelled
  ) {
    throw captureError("CANCELLED", "The screenshot was cancelled.");
  }
}

function assertSuccess<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.data as T;
}

function captureError(
  code: CaptureError["code"],
  message: string
): CaptureError {
  return { code, message };
}

function toCaptureError(error: unknown): CaptureError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    return error as CaptureError;
  }
  return captureError(
    "UNKNOWN",
    error instanceof Error ? error.message : "The screenshot could not be completed."
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function ignoreFailure(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined
  );
}
