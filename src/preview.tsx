import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { getCapture } from "./db";
import { syncThemeAssetsWithSystemPreference } from "./theme-assets";
import type { CaptureRecord, CommandResult } from "./types";
import { Brand } from "./ui/Brand";
import {
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  RetakeIcon
} from "./ui/icons";
import { ToolbarButton } from "./ui/ToolbarButton";
import { useActionFeedback } from "./ui/useActionFeedback";

const params = new URLSearchParams(window.location.search);

function PreviewApp() {
  const [record, setRecord] = useState<CaptureRecord>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [retakeError, setRetakeError] = useState<string>();
  const {
    pending: copying,
    run: runCopy,
    status: copyStatus
  } = useActionFeedback({
    onError: (error) =>
      setCopyError(actionErrorMessage(error, "Clipboard access was denied."))
  });
  const {
    pending: downloading,
    run: runDownload,
    status: downloadStatus
  } = useActionFeedback();
  const {
    pending: retaking,
    run: runRetake,
    status: retakeStatus
  } = useActionFeedback({
    resetAfter: 2400,
    onError: (error) =>
      setRetakeError(
        actionErrorMessage(error, "The retake could not be started.")
      )
  });

  useEffect(() => syncThemeAssetsWithSystemPreference(), []);

  useEffect(() => {
    let active = true;
    let createdUrl: string | undefined;
    const suppliedError = params.get("error");
    const captureId = params.get("id");

    if (suppliedError) {
      setErrorMessage(suppliedError);
      setErrorCode(params.get("code") ?? "Capture error");
    } else if (!captureId) {
      setErrorMessage(
        "The screenshot reference is missing or has expired."
      );
      setErrorCode("Capture error");
    } else {
      void getCapture(captureId)
        .then((stored) => {
          if (!active) {
            return;
          }
          if (!stored) {
            setErrorMessage(
              "This screenshot preview has expired. Take a new capture."
            );
            setErrorCode("Capture error");
            return;
          }

          createdUrl = URL.createObjectURL(stored.blob);
          setRecord(stored);
          setImageUrl(createdUrl);
          document.title = `${stored.filename} · Snapline`;
        })
        .catch((error: unknown) => {
          if (!active) {
            return;
          }
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "The screenshot could not be loaded."
          );
          setErrorCode("Capture error");
        });
    }

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, []);

  const available = Boolean(record && imageUrl && !errorMessage);

  const copyScreenshot = useCallback((): void => {
    if (!record || errorMessage || copying) {
      return;
    }

    setCopyError(undefined);
    void runCopy(async () => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "image/png": record.blob
          })
        ]);
      } catch {
        throw new Error("Clipboard access was denied.");
      }
    });
  }, [copying, errorMessage, record, runCopy]);

  const downloadScreenshot = useCallback((): void => {
    if (!record || !imageUrl || errorMessage || downloading) {
      return;
    }

    void runDownload(() => {
      const anchor = document.createElement("a");
      anchor.href = imageUrl;
      anchor.download = record.filename;
      anchor.rel = "noopener";
      anchor.click();
    });
  }, [downloading, errorMessage, imageUrl, record, runDownload]);

  const closePreview = useCallback(async (): Promise<void> => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.remove(tab.id);
    } else {
      window.close();
    }
  }, []);

  const retakeScreenshot = useCallback((): void => {
    if (!record || errorMessage || retaking) {
      return;
    }

    setRetakeError(undefined);
    void runRetake(async () => {
      const response = (await chrome.runtime.sendMessage({
        target: "background",
        type: "START_CAPTURE",
        mode: record.mode,
        tabId: record.source.tabId
      })) as CommandResult;
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      await closePreview();
    });
  }, [
    closePreview,
    errorMessage,
    record,
    retaking,
    runRetake
  ]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "r" && available && !retaking) {
        event.preventDefault();
        retakeScreenshot();
      } else if (key === "c" && available && !copying) {
        event.preventDefault();
        copyScreenshot();
      } else if (key === "d" && available) {
        event.preventDefault();
        downloadScreenshot();
      }
    };

    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [
    available,
    copying,
    copyScreenshot,
    downloadScreenshot,
    retakeScreenshot,
    retaking
  ]);

  const filename = errorMessage
    ? "Capture unavailable"
    : record?.filename ?? "Preparing screenshot…";
  const metadata = errorMessage
    ? errorCode ?? "Capture error"
    : record
      ? captureMetadata(record)
      : "Preparing preview…";

  return (
    <main class="preview-shell min-h-screen">
      <header class="preview-toolbar sticky top-0 z-[2] flex min-h-16 items-center justify-between border-b border-line bg-toolbar px-4 py-2.5 backdrop-blur-[6px]">
        <div class="preview-title flex min-w-0 items-center gap-[13px]">
          <div class="min-w-0">
            <h1
              class="m-0 max-w-[min(38vw,620px)] overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-[1.2] font-medium tracking-[-.02em] text-content"
              id="capture-filename"
              title={record?.filename}
            >
              {filename}
            </h1>
            <p class="mt-[3px] mb-0 text-[11px] text-muted" id="capture-meta">
              {metadata}
            </p>
          </div>
        </div>

        <Brand placement="preview" id="preview-brand" />

        <div
          class="preview-actions relative flex items-center gap-1.5"
          id="preview-actions"
        >
          <ToolbarButton
            id="retake-button"
            label="Retake"
            icon={<RetakeIcon />}
            shortcut="R"
            status={retakeStatus}
            pendingLabel="Retaking…"
            errorLabel="Try again"
            statusMessage={retakeError}
            disabled={!available || retaking}
            onClick={retakeScreenshot}
          />
          <ToolbarButton
            id="copy-button"
            label="Copy"
            icon={<CopyIcon />}
            shortcut="C"
            status={copyStatus}
            pendingLabel="Copying…"
            successLabel="Copied"
            errorLabel="Failed"
            statusMessage={copyError}
            disabled={!available || copying}
            onClick={copyScreenshot}
          />
          <ToolbarButton
            id="download-button"
            label="Download"
            icon={<DownloadIcon />}
            shortcut="D"
            primary
            status={downloadStatus}
            pendingLabel="Starting…"
            successLabel="Started"
            errorLabel="Failed"
            disabled={!available || downloading}
            onClick={downloadScreenshot}
          />
          <ToolbarButton
            id="close-button"
            label="Close preview"
            icon={<CloseIcon />}
            iconOnly
            title="Close"
            onClick={() => void closePreview()}
          />
        </div>

      </header>

      <section
        class="preview-stage grid min-h-[calc(100vh-64px)] items-start justify-items-center p-11"
        id="preview-stage"
        aria-busy={!imageLoaded && !errorMessage}
      >
        {errorMessage ? (
          <div
            class="preview-error max-w-[420px] self-center justify-self-center text-center text-content"
            id="preview-error"
          >
            <span
              class="preview-error__icon mx-auto mb-4 grid size-12 place-items-center rounded-full bg-danger-soft text-2xl font-bold text-danger"
              aria-hidden="true"
            >
              !
            </span>
            <h2 class="m-0 text-2xl font-normal">Capture couldn’t finish</h2>
            <p
              class="mt-2 mb-0 text-base leading-[1.55] font-light text-muted"
              id="preview-error-message"
            >
              {errorMessage}
            </p>
          </div>
        ) : (
          <>
            {!imageLoaded && (
              <div
                class="preview-loading self-center justify-self-center text-center text-base text-muted"
                id="preview-loading"
              >
                <span
                  class="spinner inline-block size-6 animate-spinner rounded-full border-2 border-line border-t-accent"
                  aria-hidden="true"
                ></span>
                <p>Loading screenshot…</p>
              </div>
            )}
            {imageUrl && (
              <img
                class="block h-auto max-w-[min(100%,1440px)] rounded-[4px] border border-image-line bg-image shadow-preview"
                id="preview-image"
                src={imageUrl}
                alt="Captured screenshot"
                onLoad={() => setImageLoaded(true)}
                onError={() => {
                  setErrorMessage(
                    "Chrome could not display this unusually large PNG. The file may still be downloadable."
                  );
                  setErrorCode("Capture error");
                }}
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}

function captureMetadata(record: CaptureRecord): string {
  const size = `${formatNumber(record.width)} × ${formatNumber(record.height)}`;
  const warning =
    record.height > 50_000
      ? " · very tall image; some apps may not open it"
      : "";
  return `${modeLabel(record.mode)} · ${size} · PNG${warning}`;
}

function modeLabel(mode: CaptureRecord["mode"]): string {
  switch (mode) {
    case "area":
      return "Selected area";
    case "visible":
      return "Visible page";
    case "full":
      return "Full page";
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function actionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing preview application root.");
}
render(<PreviewApp />, root);
