import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { syncThemeAssetsWithSystemPreference } from "./theme-assets";
import type {
  CaptureMode,
  CommandResult,
  FullCaptureProgressMessage,
  StillCaptureProgressMessage
} from "./types";
import {
  AreaIcon,
  FullPageIcon,
  VisibleIcon
} from "./ui/icons";
import { Brand } from "./ui/Brand";

interface CaptureActionDefinition {
  mode: CaptureMode;
  command: string;
  shortcutKey: string;
  label: string;
  Icon: typeof AreaIcon;
}

interface ShortcutLabel {
  text: string;
  description: string;
}

interface PopupStatus {
  message: string;
  isError: boolean;
}

const CAPTURE_ACTIONS: CaptureActionDefinition[] = [
  {
    mode: "area",
    command: "capture-area",
    shortcutKey: "A",
    label: "Area",
    Icon: AreaIcon
  },
  {
    mode: "visible",
    command: "capture-visible",
    shortcutKey: "V",
    label: "Visible",
    Icon: VisibleIcon
  },
  {
    mode: "full",
    command: "capture-full",
    shortcutKey: "F",
    label: "Full page",
    Icon: FullPageIcon
  }
];

const EMPTY_STATUS: PopupStatus = { message: "", isError: false };
const IS_MAC = isMacPlatform();

function PopupApp() {
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] =
    useState<FullCaptureProgressMessage | null>(null);
  const [stillProgress, setStillProgress] =
    useState<StillCaptureProgressMessage | null>(null);
  const [status, setStatus] = useState<PopupStatus>(EMPTY_STATUS);
  const shortcuts = useCaptureShortcuts();

  useEffect(() => syncThemeAssetsWithSystemPreference(), []);

  useEffect(() => {
    const onProgress = (message: unknown): false => {
      if (isFullCaptureProgress(message) && isActiveProgress(message)) {
        setProgress(message);
        setStillProgress(null);
        setBusy(true);
        setCancelling(false);
        setStatus(EMPTY_STATUS);
      } else if (isFullCaptureProgress(message) && message.phase === "cancelled") {
        setProgress(null);
        setBusy(false);
        setCancelling(false);
        setStatus({ message: "Capture cancelled.", isError: false });
      } else if (isFullCaptureProgress(message) && message.phase === "error") {
        setProgress(null);
        setBusy(false);
        setCancelling(false);
        setStatus({
          message:
            message.message ?? "The screenshot could not be completed.",
          isError: true
        });
      } else if (isStillCaptureProgress(message)) {
        if (isActiveStillProgress(message)) {
          setStillProgress(message);
          setBusy(true);
          setStatus(EMPTY_STATUS);
        } else {
          setStillProgress(null);
          setBusy(false);
          setStatus({
            message:
              message.message ?? "The screenshot could not be completed.",
            isError: true
          });
        }
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(onProgress);
    return () => chrome.runtime.onMessage.removeListener(onProgress);
  }, []);

  useEffect(() => {
    let active = true;
    void chrome.runtime
      .sendMessage({
        target: "background",
        type: "GET_ACTIVE_FULL_PROGRESS"
      })
      .then((response: CommandResult<FullCaptureProgressMessage>) => {
        const restored = response.ok ? response.data : undefined;
        if (!active || !restored || !isActiveProgress(restored)) {
          return;
        }
        setProgress(restored);
        setBusy(true);
        setStatus(EMPTY_STATUS);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void chrome.runtime
      .sendMessage({
        target: "background",
        type: "GET_ACTIVE_STILL_PROGRESS"
      })
      .then((response: CommandResult<StillCaptureProgressMessage>) => {
        const restored = response.ok ? response.data : undefined;
        if (!active || !restored || !isActiveStillProgress(restored)) {
          return;
        }
        setStillProgress(restored);
        setBusy(true);
        setStatus(EMPTY_STATUS);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const startCapture = async (mode: CaptureMode): Promise<void> => {
    setBusy(true);
    setCancelling(false);
    setStatus({
      message:
        mode === "area"
          ? "Opening area selector…"
          : mode === "full"
            ? ""
            : "Capturing visible page…",
      isError: false
    });
    if (mode === "full") {
      setProgress({
        target: "popup",
        type: "FULL_CAPTURE_PROGRESS",
        jobId: "pending",
        phase: "preparing"
      });
    } else {
      setStillProgress({
        target: "popup",
        type: "STILL_CAPTURE_PROGRESS",
        jobId: "pending",
        mode,
        phase: "capturing"
      });
    }

    try {
      const response = (await chrome.runtime.sendMessage({
        target: "background",
        type: "START_CAPTURE",
        mode
      })) as CommandResult;
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      if (mode === "area") {
        window.close();
      } else if (mode === "visible") {
        setStillProgress(null);
        setStatus({ message: "Screenshot ready.", isError: false });
        window.setTimeout(() => window.close(), 240);
      }
    } catch (error: unknown) {
      setBusy(false);
      setProgress(null);
      setStillProgress(null);
      setStatus({
        message:
          error instanceof Error
            ? error.message
            : "The screenshot could not be started.",
        isError: true
      });
    }
  };

  const cancelFullCapture = async (): Promise<void> => {
    setCancelling(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        target: "background",
        type: "CANCEL_ACTIVE_FULL"
      })) as CommandResult;
      if (!response.ok) {
        throw new Error(response.error.message);
      }
    } catch (error: unknown) {
      setBusy(false);
      setCancelling(false);
      setProgress(null);
      setStatus({
        message:
          error instanceof Error
            ? error.message
            : "The capture could not be cancelled.",
        isError: true
      });
    }
  };

  const hasProgress = Boolean(progress || stillProgress);
  return (
    <main
      class={`popup ${hasProgress ? "popup--capturing p-0" : "p-3.5"}`}
      aria-labelledby="popup-title"
    >
      {!hasProgress && (
        <header class="popup__header mb-3 flex items-center justify-between">
          <h1
            class="m-0 text-base leading-[1.2] font-medium tracking-[-0.02em] text-content"
            id="popup-title"
          >
            Capture
          </h1>
          <Brand placement="popup" />
        </header>
      )}

      {!hasProgress ? (
        <div
          class="capture-list grid gap-1.5"
          role="group"
          aria-label="Capture options"
        >
          {CAPTURE_ACTIONS.map((action) => (
            <CaptureAction
              key={action.mode}
              action={action}
              shortcut={shortcuts[action.mode]}
              disabled={busy}
              onCapture={startCapture}
            />
          ))}
        </div>
      ) : progress ? (
        <FullCaptureProgress
          progress={progress}
          cancelling={cancelling}
          onCancel={cancelFullCapture}
        />
      ) : stillProgress ? (
        <StillCaptureProgress progress={stillProgress} />
      ) : null}

      <p
        class={`popup__status mx-0.5 mt-2.5 -mb-0.5 text-[11px] leading-[1.4] empty:hidden ${
          status.isError ? "text-danger" : "text-muted"
        }`}
        id="status"
        role="status"
        aria-live="polite"
        data-kind={status.isError ? "error" : "status"}
      >
        {status.message}
      </p>
    </main>
  );
}

interface CaptureActionProps {
  action: CaptureActionDefinition;
  shortcut: ShortcutLabel;
  disabled: boolean;
  onCapture: (mode: CaptureMode) => Promise<void>;
}

function CaptureAction({
  action,
  shortcut,
  disabled,
  onCapture
}: CaptureActionProps) {
  const { Icon } = action;
  return (
    <button
      class="capture-action flex min-h-[42px] w-full items-center gap-2.5 rounded-control border border-line bg-surface py-0 pr-[5px] pl-[9px] text-left shadow-control cursor-pointer transition-[border-color,background-color,box-shadow,transform] duration-[140ms] hover:border-line-strong hover:bg-surface-hover hover:shadow-control-hover enabled:active:translate-y-px enabled:active:scale-[.99] enabled:active:shadow-none focus-visible:outline-[3px] focus-visible:outline-accent-focus focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-[.58] disabled:transform-none"
      data-mode={action.mode}
      type="button"
      disabled={disabled}
      onClick={() => void onCapture(action.mode)}
    >
      <span
        class="capture-action__icon grid size-7 shrink-0 place-items-center text-icon [&_svg]:size-[22px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:1.7]"
        aria-hidden="true"
      >
        <Icon />
      </span>
      <span class="capture-action__label flex-1 text-[13px] font-medium">
        {action.label}
      </span>
      <kbd
        class="inline-flex h-[22px] min-w-14 items-center justify-center rounded-[2px] border border-shortcut-line bg-shortcut px-[5px] text-[11px] font-normal tracking-[.01em] whitespace-nowrap text-muted"
        data-command={action.command}
        data-shortcut-key={action.shortcutKey}
        aria-label={shortcut.description}
      >
        {shortcut.text}
      </kbd>
    </button>
  );
}

interface FullCaptureProgressProps {
  progress: FullCaptureProgressMessage;
  cancelling: boolean;
  onCancel: () => Promise<void>;
}

interface CaptureProgressSurfaceProps {
  id: string;
  labelId: string;
  trackId: string;
  fillId: string;
  label: string;
  phase: string;
  trackLabel: string;
  fillClass: string;
  value?: number;
  valueText?: string;
  dataMode?: string;
  ariaBusy?: boolean;
  showValueRange?: boolean;
  cancel?: {
    id: string;
    disabled: boolean;
    onClick: () => void;
  };
}

function CaptureProgressSurface({
  id,
  labelId,
  trackId,
  fillId,
  label,
  phase,
  trackLabel,
  fillClass,
  value,
  valueText,
  dataMode,
  ariaBusy,
  showValueRange = false,
  cancel
}: CaptureProgressSurfaceProps) {
  return (
    <section
      class={`full-progress group grid min-h-11 items-center gap-[9px] border-0 rounded-none bg-surface py-2 pr-2.5 pl-3 text-left text-content shadow-none ${
        cancel
          ? "grid-cols-[7px_minmax(108px,1fr)_44px_auto]"
          : "grid-cols-[7px_minmax(108px,1fr)_16px]"
      }`}
      id={id}
      aria-labelledby={labelId}
      aria-busy={ariaBusy}
      data-mode={dataMode}
      data-phase={phase}
    >
      <span
        class="full-progress__indicator size-[7px] rounded-full bg-accent shadow-[0_0_0_4px_var(--accent-ring)] animate-capture-pulse"
        aria-hidden="true"
      ></span>
      <p
        class="full-progress__label m-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium tracking-normal text-content"
        id={labelId}
      >
        {label}
      </p>
      <div
        class="full-progress__track h-[3px] overflow-hidden rounded-full bg-progress-track"
        id={trackId}
        role="progressbar"
        aria-label={trackLabel}
        aria-valuemin={showValueRange ? 0 : undefined}
        aria-valuemax={showValueRange ? 100 : undefined}
        aria-valuenow={value}
        aria-valuetext={valueText}
      >
        <span
          class={fillClass}
          id={fillId}
          style={value === undefined ? undefined : { width: `${value}%` }}
        ></span>
      </div>
      {cancel && (
        <button
          class="full-progress__cancel rounded-control border-0 bg-transparent px-[5px] py-1 text-[11px] font-normal text-muted cursor-pointer transition-[color,background-color] duration-[140ms] hover:bg-surface-hover hover:text-content disabled:cursor-wait disabled:opacity-60"
          id={cancel.id}
          type="button"
          disabled={cancel.disabled}
          onClick={cancel.onClick}
        >
          Cancel
        </button>
      )}
    </section>
  );
}

function FullCaptureProgress({
  progress,
  cancelling,
  onCancel
}: FullCaptureProgressProps) {
  const presentation = getProgressPresentation(progress, cancelling);
  return (
    <CaptureProgressSurface
      id="full-progress"
      labelId="full-progress-label"
      trackId="full-progress-track"
      fillId="full-progress-fill"
      label={presentation.label}
      phase={progress.phase}
      trackLabel="Full-page capture progress"
      fillClass="full-progress__fill block h-full w-[8%] translate-x-0 rounded-[inherit] bg-accent transition-[width] duration-[180ms] group-data-[phase=encoding]:w-[34%] group-data-[phase=encoding]:animate-process-progress"
      value={presentation.value}
      valueText={presentation.valueText}
      showValueRange
      cancel={{
        id: "full-progress-cancel",
        disabled: !presentation.cancellable,
        onClick: () => void onCancel()
      }}
    />
  );
}

function StillCaptureProgress({
  progress
}: {
  progress: StillCaptureProgressMessage;
}) {
  const label =
    progress.phase === "processing"
      ? "Processing screenshot…"
      : progress.mode === "area"
        ? "Capturing selected area…"
        : "Capturing visible page…";
  return (
    <CaptureProgressSurface
      id="still-progress"
      labelId="still-progress-label"
      trackId="still-progress-track"
      fillId="still-progress-fill"
      label={label}
      phase={progress.phase}
      trackLabel="Screenshot progress"
      fillClass="full-progress__fill block h-full w-[34%] translate-x-0 rounded-[inherit] bg-accent animate-process-progress"
      dataMode={progress.mode}
      ariaBusy
      valueText={label.replace("…", "")}
    />
  );
}

function getProgressPresentation(
  progress: FullCaptureProgressMessage,
  cancelling: boolean
): {
  label: string;
  value?: number;
  valueText?: string;
  cancellable: boolean;
} {
  if (cancelling) {
    return {
      label: "Cancelling…",
      value: progressValue(progress),
      cancellable: false
    };
  }

  switch (progress.phase) {
    case "preparing":
      return {
        label: "Preparing full page…",
        value: 4,
        cancellable: true
      };
    case "capturing": {
      const current = progress.current ?? 1;
      const total = Math.max(current, progress.total ?? current);
      return {
        label: `Capturing ${current} of ${total}`,
        value: progressValue(progress),
        cancellable: true
      };
    }
    case "encoding":
      return {
        label: "Processing screenshot…",
        valueText: "Processing screenshot",
        cancellable: false
      };
    case "complete":
      return {
        label: "Screenshot ready",
        value: 100,
        cancellable: false
      };
    default:
      return {
        label: "Preparing full page…",
        value: 4,
        cancellable: false
      };
  }
}

function progressValue(
  progress: FullCaptureProgressMessage
): number | undefined {
  if (progress.phase === "capturing") {
    const current = progress.current ?? 1;
    const total = Math.max(current, progress.total ?? current);
    return Math.round((current / total) * 88);
  }
  return progress.phase === "encoding" ? undefined : 4;
}

function useCaptureShortcuts(): Record<CaptureMode, ShortcutLabel> {
  const [shortcuts, setShortcuts] = useState(() =>
    defaultShortcutLabels(IS_MAC)
  );

  useEffect(() => {
    let active = true;
    void chrome.commands
      .getAll()
      .then((commands) => {
        if (!active) {
          return;
        }
        const registered = new Map(
          commands.map((command) => [
            command.name ?? "",
            command.shortcut ?? ""
          ])
        );
        const labels = Object.fromEntries(
          CAPTURE_ACTIONS.map((action) => {
            // Some Chromium browsers expose only a subset of registered
            // command shortcuts. Resolve each action independently so one
            // blank value cannot make that action appear unmapped.
            const shortcut =
              registered.get(action.command) ||
              defaultShortcut(action.shortcutKey);
            return [
              action.mode,
              shortcutLabel(shortcut, IS_MAC)
            ];
          })
        ) as Record<CaptureMode, ShortcutLabel>;
        setShortcuts(labels);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return shortcuts;
}

function defaultShortcutLabels(
  isMac: boolean
): Record<CaptureMode, ShortcutLabel> {
  return Object.fromEntries(
    CAPTURE_ACTIONS.map((action) => [
      action.mode,
      shortcutLabel(defaultShortcut(action.shortcutKey), isMac)
    ])
  ) as Record<CaptureMode, ShortcutLabel>;
}

function defaultShortcut(key: string): string {
  return `Alt+Shift+${key}`;
}

function shortcutLabel(
  shortcut: string | undefined,
  isMac: boolean
): ShortcutLabel {
  if (!shortcut) {
    return { text: "Unassigned", description: "Shortcut unassigned" };
  }
  return {
    text: formatShortcut(shortcut, isMac),
    description: describeShortcut(shortcut)
  };
}

function formatShortcut(shortcut: string, isMac: boolean): string {
  if (isMac && !shortcut.includes("+")) {
    return (
      shortcut
        .match(/[⌘⌥⌃⇧]|[^⌘⌥⌃⇧]+/g)
        ?.map((token) => token.trim())
        .filter(Boolean)
        .join(" ") ?? shortcut
    );
  }

  const tokens = shortcut.split("+");
  if (!isMac) {
    return tokens
      .map((token) => (token === "Shift" ? "⇧" : token))
      .join(" ");
  }

  const macSymbols: Record<string, string> = {
    Alt: "⌥",
    Command: "⌘",
    Ctrl: "⌃",
    MacCtrl: "⌃",
    Shift: "⇧"
  };
  return tokens.map((token) => macSymbols[token] ?? token).join(" ");
}

function describeShortcut(shortcut: string): string {
  return shortcut
    .replaceAll("⌥", " Option ")
    .replaceAll("⇧", " Shift ")
    .replaceAll("⌘", " Command ")
    .replaceAll("⌃", " Control ")
    .replaceAll("+", " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isMacPlatform(): boolean {
  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  const platform = userAgentData?.platform?.trim();
  if (platform) {
    return platform.toLowerCase() === "macos";
  }

  const userAgent = navigator.userAgent.trim();
  return userAgent === "" || /Macintosh|Mac OS X/i.test(userAgent);
}

function isActiveProgress(
  message: FullCaptureProgressMessage
): boolean {
  return (
    message.phase === "preparing" ||
    message.phase === "capturing" ||
    message.phase === "encoding" ||
    message.phase === "complete"
  );
}

function isActiveStillProgress(
  message: StillCaptureProgressMessage
): boolean {
  return message.phase === "capturing" || message.phase === "processing";
}

function isFullCaptureProgress(
  message: unknown
): message is FullCaptureProgressMessage {
  return isPopupProgress<FullCaptureProgressMessage>(
    message,
    "FULL_CAPTURE_PROGRESS"
  );
}

function isStillCaptureProgress(
  message: unknown
): message is StillCaptureProgressMessage {
  return isPopupProgress<StillCaptureProgressMessage>(
    message,
    "STILL_CAPTURE_PROGRESS"
  );
}

function isPopupProgress<T extends { target: "popup"; type: string }>(
  message: unknown,
  type: T["type"]
): message is T {
  return (
    typeof message === "object" &&
    message !== null &&
    "target" in message &&
    message.target === "popup" &&
    "type" in message &&
    message.type === type
  );
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing popup application root.");
}
render(<PopupApp />, root);
