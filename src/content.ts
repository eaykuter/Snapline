import type { ContentCommand, SelectionRect, ViewportMetrics } from "./types";

interface StoredVisibility {
  element: HTMLElement;
  value: string;
  priority: string;
  documentTop?: number;
}

interface StoredVideo {
  wasPlaying: boolean;
  wasPresentAtStart: boolean;
  originalCurrentTime: number;
  onPlaybackAttempt: () => void;
  playbackListenersAttached: boolean;
  presentation?: StoredVideoPresentation;
}

interface StoredVideoPresentation {
  fallbackElement: HTMLElement;
  fallbackMarkerValue: string | null;
  hiddenMarkerValue: string | null;
  disabledSources: Array<{
    element: HTMLSourceElement;
    mediaValue: string | null;
  }>;
}

interface StoredAnimation {
  wasRunning: boolean;
}

type NearbyMedia = HTMLImageElement | HTMLVideoElement;

const DOCUMENT_FONT_TIMEOUT_MS = 700;
const INITIAL_READINESS_DELAY_MS = 110;
const VIEWPORT_READINESS_TIMEOUT_MS = 1_500;
const LAYOUT_SAMPLE_INTERVAL_MS = 60;
const REQUIRED_STABLE_SAMPLES = 2;
const MEDIA_DECODE_TIMEOUT_MS = 120;
const MAX_NEARBY_MEDIA = 48;
const WARMUP_PASSES = 2;
const FALLBACK_ANCESTOR_LIMIT = 4;
const VIDEO_SEEK_TIMEOUT_MS = 120;
const VIDEO_HIDDEN_ATTRIBUTE = "data-snapline-video-hidden";
const FALLBACK_VISIBLE_ATTRIBUTE = "data-snapline-fallback-visible";
const VIDEO_FALLBACK_SELECTOR = [
  "[data-video-fallback]",
  "[data-fallback]",
  "[data-fallback-frame]",
  ".fallback",
  ".fallback-frame",
  ".video-fallback",
  ".video-poster",
  ".poster-frame"
].join(",");

interface FullSession {
  jobId: string;
  cancelled: boolean;
  restoration?: Promise<void>;
  originalScrollX: number;
  originalScrollY: number;
  htmlScrollBehavior: string;
  htmlScrollPriority: string;
  bodyScrollBehavior: string;
  bodyScrollPriority: string;
  fixedElements: StoredVisibility[];
  stickyElements: StoredVisibility[];
  videos: Map<HTMLVideoElement, StoredVideo>;
  animations: Map<Animation, StoredAnimation>;
  playbackLocked: boolean;
  videosFrozen: boolean;
  pendingVideoSettlements: Map<HTMLVideoElement, Promise<void>>;
  mutationVersion: number;
  freezeStyle: HTMLStyleElement;
  removeInputGuards: () => void;
  stopVideoObserver: () => void;
}

interface SnaplineGlobals {
  contentInstalled?: boolean;
  areaCleanup?: () => void;
  fullSession?: FullSession;
}

const globals = window as Window & { __snapline?: SnaplineGlobals };
globals.__snapline ??= {};

if (!globals.__snapline.contentInstalled) {
  globals.__snapline.contentInstalled = true;

  chrome.runtime.onMessage.addListener(
    (
      message: ContentCommand,
      _sender,
      sendResponse: (response: unknown) => void
    ) => {
      if (message?.target !== "content") {
        return false;
      }

      void handleMessage(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: {
              code: "CAPTURE_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The page could not prepare for capture."
            }
          });
        });

      return true;
    }
  );
}

async function handleMessage(message: ContentCommand): Promise<unknown> {
  switch (message.type) {
    case "PING":
      return { installed: true };

    case "START_AREA":
      return await startAreaSelector();

    case "CANCEL_AREA":
      globals.__snapline?.areaCleanup?.();
      return undefined;

    case "READ_VIEWPORT":
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };

    case "PREPARE_FULL":
      return prepareFullCapture(message.jobId);

    case "SCROLL_FULL":
      return await scrollForFullCapture(
        message.jobId,
        message.y,
        message.tileIndex
      );

    case "RESTORE_FULL":
      return await restoreFullCapture(message.jobId);
  }
}

async function startAreaSelector(): Promise<void> {
  globals.__snapline?.areaCleanup?.();
  await restoreFullCapture();

  const host = document.createElement("div");
  host.dataset.snaplineUi = "area";
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .veil {
        position: fixed;
        inset: 0;
        background: rgb(9 9 11 / 60%);
        pointer-events: none;
      }
      .selection {
        position: fixed;
        display: none;
        border: 2px solid #2563eb;
        background: transparent;
        box-shadow: 0 0 0 99999px rgb(9 9 11 / 60%);
        pointer-events: none;
      }
      .size {
        position: absolute;
        left: 50%;
        top: calc(100% + 10px);
        padding: 5px 8px;
        border: 1px solid #3f3f46;
        border-radius: 6px;
        background: #18181b;
        box-shadow: 0 5px 16px rgb(0 0 0 / 22%);
        color: white;
        font: 600 12px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        white-space: nowrap;
        transform: translateX(-50%);
      }
      .size[data-error="true"] {
        background: #b42318;
      }
    </style>
    <div class="veil"></div>
    <div class="selection"><span class="size">0 × 0</span></div>
  `;

  const selection = shadow.querySelector<HTMLDivElement>(".selection");
  const size = shadow.querySelector<HTMLSpanElement>(".size");
  const veil = shadow.querySelector<HTMLDivElement>(".veil");
  if (!selection || !size || !veil) {
    throw new Error("The area selector could not be created.");
  }

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let currentRect: SelectionRect | undefined;

  const cleanup = (): void => {
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    host.remove();
    if (globals.__snapline?.areaCleanup === cleanup) {
      globals.__snapline.areaCleanup = undefined;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    startX = clamp(event.clientX, 0, window.innerWidth);
    startY = clamp(event.clientY, 0, window.innerHeight);
    currentRect = undefined;
    selection.style.display = "block";
    veil.style.display = "none";
    size.dataset.error = "false";
    host.setPointerCapture(event.pointerId);
    updateSelection(
      selection,
      size,
      normalizeRect(startX, startY, startX, startY)
    );
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    currentRect = normalizeRect(
      startX,
      startY,
      clamp(event.clientX, 0, window.innerWidth),
      clamp(event.clientY, 0, window.innerHeight)
    );
    updateSelection(selection, size, currentRect);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    dragging = false;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }

    const rect =
      currentRect ??
      normalizeRect(startX, startY, event.clientX, event.clientY);
    if (rect.width < 8 || rect.height < 8) {
      size.textContent = "Drag a larger area";
      size.dataset.error = "true";
      return;
    }

    cleanup();
    void afterTwoFrames().then(() =>
      chrome.runtime.sendMessage({
        target: "background",
        type: "AREA_SELECTED",
        rect,
        viewport: {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        }
      })
    );
  };

  const onPointerCancel = (): void => {
    dragging = false;
  };

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown, true);
  document.documentElement.append(host);
  globals.__snapline!.areaCleanup = cleanup;
}

function updateSelection(
  element: HTMLDivElement,
  size: HTMLSpanElement,
  rect: SelectionRect
): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  const bitmapScale =
    Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  size.textContent = `${Math.round(rect.width * bitmapScale)} × ${Math.round(rect.height * bitmapScale)}`;

  const badgeBelow = rect.y + rect.height + 44 <= window.innerHeight;
  size.style.top = badgeBelow ? "calc(100% + 10px)" : "auto";
  size.style.bottom = badgeBelow ? "auto" : "calc(100% + 10px)";
}

async function prepareFullCapture(jobId: string): Promise<ViewportMetrics> {
  globals.__snapline?.areaCleanup?.();
  await restoreFullCapture();

  const body = document.body;
  const html = document.documentElement;
  const scrolling = document.scrollingElement ?? html;
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  const fixedElements: StoredVisibility[] = [];
  const stickyElements: StoredVisibility[] = [];

  if (body) {
    for (const element of body.querySelectorAll<HTMLElement>("*")) {
      if (element.dataset.snaplineUi) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }
      const stored: StoredVisibility = {
        element,
        value: element.style.getPropertyValue("visibility"),
        priority: element.style.getPropertyPriority("visibility")
      };
      if (style.position === "fixed") {
        fixedElements.push(stored);
      } else {
        stored.documentTop = measureNaturalDocumentTop(element);
        stickyElements.push(stored);
      }
    }
  }

  const freezeStyle = document.createElement("style");
  freezeStyle.dataset.snaplineUi = "freeze";
  freezeStyle.textContent = `
    html, body {
      scroll-behavior: auto !important;
      scroll-snap-type: none !important;
      scrollbar-gutter: auto !important;
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    html::-webkit-scrollbar,
    body::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    * {
      caret-color: transparent !important;
    }
    [${VIDEO_HIDDEN_ATTRIBUTE}="true"] {
      visibility: hidden !important;
    }
    [${FALLBACK_VISIBLE_ATTRIBUTE}="true"] {
      display: revert !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: none !important;
    }
  `;
  (document.head ?? html).append(freezeStyle);

  const removeInputGuards = addInputGuards(jobId);
  const bodyScrollBehavior = body?.style.getPropertyValue("scroll-behavior") ?? "";
  const bodyScrollPriority = body?.style.getPropertyPriority("scroll-behavior") ?? "";

  const session: FullSession = {
    jobId,
    cancelled: false,
    originalScrollX,
    originalScrollY,
    htmlScrollBehavior: html.style.getPropertyValue("scroll-behavior"),
    htmlScrollPriority: html.style.getPropertyPriority("scroll-behavior"),
    bodyScrollBehavior,
    bodyScrollPriority,
    fixedElements,
    stickyElements,
    videos: new Map(),
    animations: new Map(),
    playbackLocked: true,
    videosFrozen: false,
    pendingVideoSettlements: new Map(),
    mutationVersion: 0,
    freezeStyle,
    removeInputGuards,
    stopVideoObserver: () => {}
  };

  globals.__snapline!.fullSession = session;
  session.stopVideoObserver = watchForVideoInsertions(session);
  rememberVideosAtStart(session);
  lockVideoPlayback(session);
  rememberTimeBasedAnimations(session);
  html.style.setProperty("scroll-behavior", "auto", "important");
  body?.style.setProperty("scroll-behavior", "auto", "important");
  await afterTwoFrames();
  ensureFullSessionActive(session);
  await waitForDocumentFonts(DOCUMENT_FONT_TIMEOUT_MS);
  ensureFullSessionActive(session);
  await afterTwoFrames();
  ensureFullSessionActive(session);
  await warmupPage(session);
  ensureFullSessionActive(session);
  freezeVideos(session);
  await waitForVideoSettlements(session);
  ensureFullSessionActive(session);
  freezeTimeBasedAnimations(session);
  await afterTwoFrames();
  ensureFullSessionActive(session);

  const viewportHeight = window.innerHeight;
  const documentHeight = Math.max(
    viewportHeight,
    Math.round(measureDocumentHeight(scrolling, html, body))
  );

  freezeStyle.textContent += `
    html { min-height: ${documentHeight}px !important; }
  `;
  ensureFullSessionActive(session);
  window.scrollTo(0, 0);
  await afterTwoFrames();
  ensureFullSessionActive(session);

  return {
    viewportWidth: window.innerWidth,
    viewportHeight,
    contentWidth: Math.max(1, html.clientWidth),
    documentHeight
  };
}

async function warmupPage(session: FullSession): Promise<void> {
  let previousHeight = measureDocumentHeight();
  for (let pass = 0; pass < WARMUP_PASSES; pass += 1) {
    const maxY = Math.max(0, previousHeight - window.innerHeight);
    const step = Math.max(1, window.innerHeight);
    for (let y = 0; y < maxY; y += step) {
      ensureFullSessionActive(session);
      window.scrollTo(0, Math.min(y, maxY));
      await afterTwoFrames();
      ensureFullSessionActive(session);
    }
    ensureFullSessionActive(session);
    window.scrollTo(0, maxY);
    await waitForViewportReadiness(session, false);

    ensureFullSessionActive(session);
    window.scrollTo(0, 0);
    await waitForViewportReadiness(session, false);
    ensureFullSessionActive(session);
    const height = measureDocumentHeight();
    if (height <= previousHeight + 1) {
      return;
    }
    previousHeight = height;
  }
  ensureFullSessionActive(session);
  window.scrollTo(0, 0);
}

async function scrollForFullCapture(
  jobId: string,
  requestedY: number,
  tileIndex: number
): Promise<{ actualY: number }> {
  const session = getFullSession(jobId);
  applyFloatingVisibility(session, requestedY, tileIndex);

  window.scrollTo(0, requestedY);
  await waitForViewportReadiness(session, true);
  ensureFullSessionActive(session);

  return { actualY: window.scrollY };
}

async function waitForViewportReadiness(
  session: FullSession,
  freezeAtCapture: boolean
): Promise<void> {
  ensureFullSessionActive(session);
  const deadline = Date.now() + VIEWPORT_READINESS_TIMEOUT_MS;
  await afterTwoFrames();
  ensureFullSessionActive(session);
  await delay(INITIAL_READINESS_DELAY_MS);
  ensureFullSessionActive(session);

  let previousHeight = measureDocumentHeight();
  let previousMutationVersion = session.mutationVersion;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const [mediaSettled, animationsSettled] = await Promise.all([
      waitForNearbyMedia(remaining),
      waitForFiniteAnimations(remaining)
    ]);
    ensureFullSessionActive(session);

    if (Date.now() >= deadline) {
      await freezeCaptureMotion(session, freezeAtCapture);
      return;
    }

    await delay(
      Math.min(LAYOUT_SAMPLE_INTERVAL_MS, Math.max(0, deadline - Date.now()))
    );
    ensureFullSessionActive(session);
    await afterTwoFrames();
    ensureFullSessionActive(session);

    const height = measureDocumentHeight();
    const mediaStillPending = findNearbyMedia().length > 0;
    const animationsStillPending = findFiniteAnimations().length > 0;
    const mutationsStable =
      session.mutationVersion === previousMutationVersion;
    if (
      mediaSettled &&
      animationsSettled &&
      !mediaStillPending &&
      !animationsStillPending &&
      mutationsStable &&
      Math.abs(height - previousHeight) <= 1
    ) {
      stableSamples += 1;
      if (stableSamples >= REQUIRED_STABLE_SAMPLES) {
        await freezeCaptureMotion(session, freezeAtCapture);
        return;
      }
    } else {
      stableSamples = 0;
    }
    previousHeight = height;
    previousMutationVersion = session.mutationVersion;
  }

  await freezeCaptureMotion(session, freezeAtCapture);
}

async function freezeCaptureMotion(
  session: FullSession,
  freezeAtCapture: boolean
): Promise<void> {
  ensureFullSessionActive(session);
  if (!freezeAtCapture) {
    return;
  }
  freezeVideos(session);
  freezeTimeBasedAnimations(session);
  await waitForVideoSettlements(session);
  ensureFullSessionActive(session);
  await afterTwoFrames();
  ensureFullSessionActive(session);
}

function findNearbyMedia(): NearbyMedia[] {
  const viewportHeight = window.innerHeight;
  const media: NearbyMedia[] = [
    ...Array.from(document.images).filter((image) => !image.complete),
    ...Array.from(document.querySelectorAll<HTMLVideoElement>("video")).filter(
      isPendingVideo
    )
  ];

  return media.filter((element) => isNearby(element, viewportHeight)).slice(
    0,
    MAX_NEARBY_MEDIA
  );
}

function isNearby(element: Element, viewportHeight = window.innerHeight): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= -viewportHeight && rect.top <= viewportHeight * 2;
}

function isPendingVideo(video: HTMLVideoElement): boolean {
  const hasSource = Boolean(
    video.currentSrc ||
      video.src ||
      video.querySelector<HTMLSourceElement>("source[src]")
  );
  if (!hasSource || video.error) {
    return false;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return !video.poster;
  }
  return isFinitePlayingVideo(video);
}

function isFinitePlayingVideo(video: HTMLVideoElement): boolean {
  return Boolean(
    !video.paused &&
      !video.ended &&
      !video.loop &&
      Number.isFinite(video.duration)
  );
}

function isTimeBasedAnimation(animation: Animation): boolean {
  return (
    animation.timeline === document.timeline &&
    animation.effect instanceof KeyframeEffect
  );
}

function isAnimationNearby(animation: Animation): boolean {
  const effect = animation.effect;
  return !(
    effect instanceof KeyframeEffect &&
    effect.target instanceof Element
  ) || isNearby(effect.target);
}

function findFiniteAnimations(): Animation[] {
  return document.getAnimations().filter((animation) => {
    if (!isTimeBasedAnimation(animation)) {
      return false;
    }
    if (!isAnimationNearby(animation)) {
      return false;
    }
    const effect = animation.effect as KeyframeEffect;
    const timing = effect.getComputedTiming();
    return (
      Number.isFinite(timing.endTime) &&
      (animation.playState === "running" || animation.pending)
    );
  });
}

async function waitForFiniteAnimations(timeoutMs: number): Promise<boolean> {
  const pending = findFiniteAnimations();
  if (pending.length === 0) {
    return true;
  }
  return await Promise.race([
    Promise.all(
      pending.map((animation) =>
        animation.finished.then(
          () => undefined,
          () => undefined
        )
      )
    ).then(() => true),
    delay(timeoutMs).then(() => false)
  ]);
}

async function waitForNearbyMedia(timeoutMs: number): Promise<boolean> {
  const pending = findNearbyMedia();
  if (pending.length === 0) {
    return true;
  }

  const settled = await new Promise<boolean>((resolve) => {
    const remaining = new Set(pending);
    const cleanups: Array<() => void> = [];
    let finished = false;

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      window.clearTimeout(timer);
      for (const cleanup of cleanups) {
        cleanup();
      }
      resolve(remaining.size === 0);
    };

    const timer = window.setTimeout(finish, timeoutMs);
    for (const media of pending) {
      const events =
        media instanceof HTMLImageElement
          ? ["load", "error"]
          : [
              "loadeddata",
              "ended",
              "pause",
              "error",
              "abort",
              "emptied"
            ];
      const onSettled = (): void => {
        if (
          media instanceof HTMLVideoElement &&
          isFinitePlayingVideo(media)
        ) {
          return;
        }
        remaining.delete(media);
        if (remaining.size === 0) {
          finish();
        }
      };
      for (const event of events) {
        media.addEventListener(event, onSettled, { once: true });
      }
      cleanups.push(() => {
        for (const event of events) {
          media.removeEventListener(event, onSettled);
        }
      });
      if (
        media instanceof HTMLImageElement
          ? media.complete
          : !isPendingVideo(media)
      ) {
        onSettled();
      }
    }
  });

  if (settled) {
    const decodable = pending.filter(
      (media): media is HTMLImageElement =>
        media instanceof HTMLImageElement &&
        media.complete &&
        media.naturalWidth > 0
    );
    if (decodable.length > 0) {
      await Promise.race([
        Promise.all(
          decodable.map((image) => image.decode().catch(() => undefined))
        ),
        delay(Math.min(MEDIA_DECODE_TIMEOUT_MS, Math.max(0, timeoutMs)))
      ]);
    }
  }

  return settled;
}

async function waitForDocumentFonts(timeoutMs: number): Promise<void> {
  if (!document.fonts || document.fonts.status === "loaded") {
    return;
  }
  await Promise.race([
    document.fonts.ready.then(() => undefined),
    delay(timeoutMs)
  ]);
}

function measureDocumentHeight(
  scrolling = document.scrollingElement ?? document.documentElement,
  html = document.documentElement,
  body = document.body
): number {
  return Math.max(
    scrolling.scrollHeight,
    html.scrollHeight,
    body?.scrollHeight ?? 0,
    window.innerHeight
  );
}

function measureNaturalDocumentTop(element: HTMLElement): number {
  const position = element.style.getPropertyValue("position");
  const priority = element.style.getPropertyPriority("position");
  element.style.setProperty("position", "static", "important");
  const documentTop = element.getBoundingClientRect().top + window.scrollY;
  restoreStyleProperty(element, "position", position, priority);
  return documentTop;
}

function ensureFullSessionActive(session: FullSession): void {
  if (
    globals.__snapline?.fullSession !== session ||
    session.cancelled
  ) {
    throw new Error("The full-page capture session is no longer active.");
  }
}

function rememberVideosAtStart(session: FullSession): void {
  for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
    rememberVideo(session, video, true);
  }
}

function rememberVideo(
  session: FullSession,
  video: HTMLVideoElement,
  wasPresentAtStart: boolean
): StoredVideo {
  let stored = session.videos.get(video);
  if (!stored) {
    stored = {
      wasPlaying: !video.paused,
      wasPresentAtStart,
      originalCurrentTime: getVideoCurrentTime(video),
      onPlaybackAttempt: () => handleVideoPlaybackAttempt(session, video),
      playbackListenersAttached: false
    };
    session.videos.set(video, stored);
  }
  if (session.playbackLocked) {
    attachVideoPlaybackGuard(video, stored);
  }
  return stored;
}

function getVideoCurrentTime(video: HTMLVideoElement): number {
  return Number.isFinite(video.currentTime) ? video.currentTime : 0;
}

function lockVideoPlayback(session: FullSession): void {
  if (!isFullSessionActive(session)) {
    return;
  }
  session.playbackLocked = true;
  for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
    const stored = rememberVideo(session, video, false);
    lockVideo(video, stored);
  }
}

function lockVideo(video: HTMLVideoElement, stored: StoredVideo): void {
  if (!stored.wasPresentAtStart && !video.paused) {
    stored.wasPlaying = true;
  }
  attachVideoPlaybackGuard(video, stored);
  try {
    video.pause();
  } catch {
    // A page can replace pause() with a non-standard implementation.
  }
}

function attachVideoPlaybackGuard(
  video: HTMLVideoElement,
  stored: StoredVideo
): void {
  if (stored.playbackListenersAttached) {
    return;
  }
  video.addEventListener("play", stored.onPlaybackAttempt);
  video.addEventListener("playing", stored.onPlaybackAttempt);
  video.addEventListener("timeupdate", stored.onPlaybackAttempt);
  stored.playbackListenersAttached = true;
}

function handleVideoPlaybackAttempt(
  session: FullSession,
  video: HTMLVideoElement
): void {
  if (!session.playbackLocked) {
    return;
  }
  try {
    video.pause();
  } catch {
    // A page can replace pause() with a non-standard implementation.
  }
  if (
    session.videosFrozen &&
    Math.abs(getVideoCurrentTime(video)) > 0.001
  ) {
    queueVideoSettlement(session, video);
  }
}

function freezeVideos(session: FullSession): void {
  if (!isFullSessionActive(session)) {
    return;
  }
  session.videosFrozen = true;
  for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
    freezeVideo(session, video);
  }
}

function queueVideoSettlement(
  session: FullSession,
  video: HTMLVideoElement
): void {
  if (
    !isFullSessionActive(session) ||
    !session.videosFrozen ||
    !video.isConnected ||
    session.pendingVideoSettlements.has(video)
  ) {
    return;
  }

  const task = settleVideoForCapture(session, video).catch(() => undefined);
  session.pendingVideoSettlements.set(video, task);
  void task.then(() => {
    if (session.pendingVideoSettlements.get(video) === task) {
      session.pendingVideoSettlements.delete(video);
    }
  });
}

async function waitForVideoSettlements(session: FullSession): Promise<void> {
  while (session.pendingVideoSettlements.size > 0) {
    await Promise.all([...session.pendingVideoSettlements.values()]);
  }
}

async function settleVideoForCapture(
  session: FullSession,
  video: HTMLVideoElement
): Promise<void> {
  if (
    !isFullSessionActive(session) ||
    !session.videosFrozen ||
    !video.isConnected
  ) {
    return;
  }

  const stored = rememberVideo(session, video, false);
  lockVideo(video, stored);

  const fallback = findUsableVideoFallback(video);
  if (fallback) {
    prepareVideoFallback(video, stored, fallback);
  }
  if (fallback && (await waitForFallbackImage(fallback))) {
    if (
      !isFullSessionActive(session) ||
      !session.videosFrozen ||
      !video.isConnected
    ) {
      return;
    }
    showVideoFallback(video, stored, fallback);
    return;
  }

  if (
    !isFullSessionActive(session) ||
    !session.videosFrozen ||
    !video.isConnected
  ) {
    return;
  }
  clearVideoFallback(video, stored);
  await resetVideoToFirstFrame(video);
}

function watchForVideoInsertions(session: FullSession): () => void {
  const handleVideo = (video: HTMLVideoElement): void => {
    const stored = rememberVideo(session, video, false);
    if (session.playbackLocked) {
      lockVideo(video, stored);
    }
    if (session.videosFrozen) {
      queueVideoSettlement(session, video);
    }
  };
  const observer = new MutationObserver((mutations) => {
    session.mutationVersion += mutations.length;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLVideoElement) {
          handleVideo(node);
        } else if (node instanceof Element) {
          for (const video of node.querySelectorAll<HTMLVideoElement>("video")) {
            handleVideo(video);
          }
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  return () => observer.disconnect();
}

function freezeVideo(session: FullSession, video: HTMLVideoElement): void {
  if (!isFullSessionActive(session)) {
    return;
  }

  const stored = rememberVideo(session, video, false);
  lockVideo(video, stored);
  queueVideoSettlement(session, video);
}

function findUsableVideoFallback(video: HTMLVideoElement): HTMLElement | undefined {
  let scope = video.parentElement;
  for (
    let depth = 0;
    scope && depth < FALLBACK_ANCESTOR_LIMIT;
    depth += 1, scope = scope.parentElement
  ) {
    const candidates = scope.querySelectorAll<HTMLElement>(
      VIDEO_FALLBACK_SELECTOR
    );
    for (const candidate of candidates) {
      if (
        candidate === video ||
        candidate.contains(video) ||
        !isFallbackForVideo(video, candidate) ||
        !hasUsableFallbackImage(candidate)
      ) {
        continue;
      }
      return candidate;
    }
  }
  return undefined;
}

function isFallbackForVideo(
  video: HTMLVideoElement,
  fallback: HTMLElement
): boolean {
  let scope: HTMLElement | null = fallback;
  while (scope) {
    if (scope.contains(video)) {
      return scope.querySelectorAll("video").length === 1;
    }
    scope = scope.parentElement;
  }
  return false;
}

function hasUsableFallbackImage(element: HTMLElement): boolean {
  const image =
    element instanceof HTMLImageElement
      ? element
      : element.querySelector<HTMLImageElement>("img");
  if (!image) {
    return false;
  }

  const sources = [
    image.currentSrc,
    image.getAttribute("src"),
    image.getAttribute("srcset"),
    ...Array.from(element.querySelectorAll<HTMLSourceElement>("source")).flatMap(
      (source) => [source.getAttribute("src"), source.getAttribute("srcset")]
    )
  ];
  return sources.some((source) => {
    if (!source?.trim()) {
      return false;
    }
    return !isPlaceholderImageSource(source);
  });
}

function isPlaceholderImageSource(source: string): boolean {
  return /data:image\/gif;base64,r0lgodlhaqaba/i.test(source);
}

function prepareVideoFallback(
  video: HTMLVideoElement,
  stored: StoredVideo,
  fallback: HTMLElement
): void {
  if (stored.presentation?.fallbackElement !== fallback) {
    clearVideoFallback(video, stored);
    stored.presentation = {
      fallbackElement: fallback,
      fallbackMarkerValue: fallback.getAttribute(FALLBACK_VISIBLE_ATTRIBUTE),
      hiddenMarkerValue: video.getAttribute(VIDEO_HIDDEN_ATTRIBUTE),
      disabledSources: []
    };
  }

  const presentation = stored.presentation;
  if (!presentation || presentation.disabledSources.length > 0) {
    return;
  }

  for (const source of fallback.querySelectorAll<HTMLSourceElement>("source")) {
    const values = [source.getAttribute("src"), source.getAttribute("srcset")];
    if (!values.some((value) => value && isPlaceholderImageSource(value))) {
      continue;
    }
    presentation.disabledSources.push({
      element: source,
      mediaValue: source.getAttribute("media")
    });
    source.setAttribute("media", "not all");
  }
}

async function waitForFallbackImage(element: HTMLElement): Promise<boolean> {
  const image =
    element instanceof HTMLImageElement
      ? element
      : element.querySelector<HTMLImageElement>("img");
  if (!image || !hasUsableFallbackImage(element)) {
    return false;
  }

  if (!image.complete) {
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        window.clearTimeout(timer);
        image.removeEventListener("load", finish);
        image.removeEventListener("error", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, MEDIA_DECODE_TIMEOUT_MS);
      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
    });
  }

  if (!image.complete || image.naturalWidth <= 0) {
    return false;
  }
  if (typeof image.decode === "function") {
    await Promise.race([
      image.decode().catch(() => undefined),
      delay(MEDIA_DECODE_TIMEOUT_MS)
    ]);
  }
  return image.naturalWidth > 0;
}

function showVideoFallback(
  video: HTMLVideoElement,
  stored: StoredVideo,
  fallback: HTMLElement
): void {
  if (stored.presentation?.fallbackElement !== fallback) {
    prepareVideoFallback(video, stored, fallback);
  }
  fallback.setAttribute(FALLBACK_VISIBLE_ATTRIBUTE, "true");
  video.setAttribute(VIDEO_HIDDEN_ATTRIBUTE, "true");
}

function clearVideoFallback(
  video: HTMLVideoElement,
  stored: StoredVideo
): void {
  const presentation = stored.presentation;
  if (!presentation) {
    return;
  }
  restoreAttribute(
    presentation.fallbackElement,
    FALLBACK_VISIBLE_ATTRIBUTE,
    presentation.fallbackMarkerValue
  );
  for (const source of presentation.disabledSources) {
    restoreAttribute(source.element, "media", source.mediaValue);
  }
  if (presentation.disabledSources.length > 0) {
    const image = presentation.fallbackElement.querySelector<HTMLImageElement>(
      "img"
    );
    const sourceValue = image?.getAttribute("src");
    if (image && typeof sourceValue === "string") {
      try {
        image.removeAttribute("src");
        image.setAttribute("src", sourceValue);
      } catch {
        // A page can replace the image element while capture is restoring.
      }
    }
  }
  restoreAttribute(video, VIDEO_HIDDEN_ATTRIBUTE, presentation.hiddenMarkerValue);
  stored.presentation = undefined;
}

function restoreAttribute(
  element: Element,
  attribute: string,
  value: string | null
): void {
  if (value === null) {
    element.removeAttribute(attribute);
  } else {
    element.setAttribute(attribute, value);
  }
}

async function resetVideoToFirstFrame(video: HTMLVideoElement): Promise<void> {
  if (!video.isConnected) {
    return;
  }
  try {
    video.pause();
  } catch {
    return;
  }

  if (
    video.readyState < HTMLMediaElement.HAVE_METADATA ||
    Math.abs(getVideoCurrentTime(video)) < 0.001
  ) {
    return;
  }

  await seekVideo(video, 0);
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      window.clearTimeout(timer);
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, VIDEO_SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    try {
      video.currentTime = time;
    } catch {
      finish();
    }
  });
}

function rememberTimeBasedAnimations(session: FullSession): void {
  for (const animation of document.getAnimations()) {
    if (!isTimeBasedAnimation(animation) || session.animations.has(animation)) {
      continue;
    }
    session.animations.set(animation, {
      wasRunning: isRunningAnimation(animation)
    });
  }
}

function freezeTimeBasedAnimations(session: FullSession): void {
  if (!isFullSessionActive(session)) {
    return;
  }
  for (const animation of document.getAnimations()) {
    if (
      !isTimeBasedAnimation(animation) ||
      !isAnimationNearby(animation)
    ) {
      continue;
    }
    if (!session.animations.has(animation)) {
      session.animations.set(animation, {
        wasRunning: isRunningAnimation(animation)
      });
    }
    if (isRunningAnimation(animation)) {
      try {
        animation.pause();
      } catch {
        // The page can cancel an animation between inspection and pause.
      }
    }
  }
}

function isRunningAnimation(animation: Animation): boolean {
  return animation.playState === "running" || animation.pending;
}

function restoreVideos(session: FullSession): void {
  session.stopVideoObserver();
  session.playbackLocked = false;
  session.videosFrozen = false;
  for (const [video, stored] of session.videos) {
    clearVideoFallback(video, stored);
    restoreVideoTime(video, stored);
    video.removeEventListener("play", stored.onPlaybackAttempt);
    video.removeEventListener("playing", stored.onPlaybackAttempt);
    video.removeEventListener("timeupdate", stored.onPlaybackAttempt);
    stored.playbackListenersAttached = false;
    if (!stored.wasPlaying || video.ended || !video.isConnected) {
      continue;
    }
    try {
      void Promise.resolve(video.play()).catch(() => undefined);
    } catch {
      // A page can replace play() with a non-Promise implementation.
    }
  }
}

function restoreVideoTime(
  video: HTMLVideoElement,
  stored: StoredVideo
): void {
  if (
    !video.isConnected ||
    video.readyState < HTMLMediaElement.HAVE_METADATA ||
    !Number.isFinite(stored.originalCurrentTime) ||
    Math.abs(getVideoCurrentTime(video) - stored.originalCurrentTime) < 0.001
  ) {
    return;
  }
  try {
    video.currentTime = stored.originalCurrentTime;
  } catch {
    // A page can unload the media source during restoration.
  }
}

function restoreAnimations(session: FullSession): void {
  for (const [animation, stored] of session.animations) {
    if (!stored.wasRunning || animation.playState === "finished") {
      continue;
    }
    try {
      animation.play();
    } catch {
      // The page can cancel an animation during restoration.
    }
  }
}

async function restoreFullCapture(jobId?: string): Promise<void> {
  const session = globals.__snapline?.fullSession;
  if (!session || (jobId && session.jobId !== jobId)) {
    return;
  }
  if (session.restoration) {
    await session.restoration;
    return;
  }

  session.cancelled = true;
  session.stopVideoObserver();
  session.playbackLocked = false;
  session.videosFrozen = false;
  session.restoration = (async () => {
    await waitForVideoSettlements(session);
    restoreVideos(session);
    restoreAnimations(session);
    restoreVisibility(session.fixedElements);
    restoreVisibility(session.stickyElements);
    session.freezeStyle.remove();
    session.removeInputGuards();

    const html = document.documentElement;
    const body = document.body;
    restoreStyleProperty(
      html,
      "scroll-behavior",
      session.htmlScrollBehavior,
      session.htmlScrollPriority
    );
    if (body) {
      restoreStyleProperty(
        body,
        "scroll-behavior",
        session.bodyScrollBehavior,
        session.bodyScrollPriority
      );
    }

    window.scrollTo(session.originalScrollX, session.originalScrollY);
    if (globals.__snapline?.fullSession === session) {
      globals.__snapline.fullSession = undefined;
    }
  })();
  await session.restoration;
}

function addInputGuards(jobId: string): () => void {
  const blockScroll = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelFullCapture(jobId);
      return;
    }
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " "
      ].includes(event.key)
    ) {
      blockScroll(event);
    }
  };

  window.addEventListener("wheel", blockScroll, {
    capture: true,
    passive: false
  });
  window.addEventListener("touchmove", blockScroll, {
    capture: true,
    passive: false
  });
  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    window.removeEventListener("wheel", blockScroll, true);
    window.removeEventListener("touchmove", blockScroll, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

function cancelFullCapture(jobId: string): void {
  void (async () => {
    await restoreFullCapture(jobId).catch(() => undefined);
    await chrome.runtime
      .sendMessage({
        target: "background",
        type: "FULL_CANCELLED",
        jobId
      })
      .catch(() => undefined);
  })();
}

function applyFloatingVisibility(
  session: FullSession,
  requestedY: number,
  tileIndex: number
): void {
  restoreVisibility(session.fixedElements);
  restoreVisibility(session.stickyElements);

  if (tileIndex > 0) {
    hideElements(session.fixedElements);
  }

  for (const stored of session.stickyElements) {
    if (
      stored.documentTop !== undefined &&
      requestedY > stored.documentTop + 1
    ) {
      stored.element.style.setProperty("visibility", "hidden", "important");
    }
  }
}

function hideElements(elements: StoredVisibility[]): void {
  for (const stored of elements) {
    stored.element.style.setProperty("visibility", "hidden", "important");
  }
}

function restoreVisibility(elements: StoredVisibility[]): void {
  for (const stored of elements) {
    restoreStyleProperty(
      stored.element,
      "visibility",
      stored.value,
      stored.priority
    );
  }
}

function restoreStyleProperty(
  element: HTMLElement,
  property: string,
  value: string,
  priority: string
): void {
  if (value) {
    element.style.setProperty(property, value, priority);
  } else {
    element.style.removeProperty(property);
  }
}

function getFullSession(jobId: string): FullSession {
  const session = globals.__snapline?.fullSession;
  if (!session || session.jobId !== jobId || session.cancelled) {
    throw new Error("The full-page capture session is no longer active.");
  }
  return session;
}

function isFullSessionActive(session: FullSession): boolean {
  return globals.__snapline?.fullSession === session && !session.cancelled;
}

// chrome.scripting injects this output as a classic script. Vite may split
// imports shared with other entries into ESM chunks, so runtime helpers stay
// local to keep dist/content.js self-contained.
function normalizeRect(
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
