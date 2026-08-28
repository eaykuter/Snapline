import type { ComponentChildren, JSX } from "preact";
import {
  CheckIcon,
  ErrorIcon,
  SpinnerIcon
} from "./icons";

export type ToolbarButtonStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

interface ToolbarButtonProps {
  id: string;
  label: string;
  icon: ComponentChildren;
  onClick: JSX.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  shortcut?: string;
  primary?: boolean;
  iconOnly?: boolean;
  title?: string;
  status?: ToolbarButtonStatus;
  pendingLabel?: string;
  successLabel?: string;
  errorLabel?: string;
  statusMessage?: string;
}

const BASE_BUTTON =
  "toolbar-button inline-flex h-9 items-center justify-center gap-1.5 border rounded-control px-[11px] text-xs font-normal cursor-pointer transition-[background-color,border-color,color,box-shadow,transform] duration-[140ms] enabled:active:translate-y-px enabled:active:scale-[.99] enabled:active:shadow-none focus-visible:outline-[3px] focus-visible:outline-accent-focus focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-[.45] [&_svg]:size-[17px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:1.8]";
const SECONDARY_BUTTON =
  "border-line bg-surface text-content shadow-control hover:border-line-strong hover:bg-surface-hover hover:shadow-control-hover";
const PRIMARY_BUTTON =
  "border-accent bg-accent text-white shadow-control-primary hover:border-accent-hover hover:bg-accent-hover hover:text-white hover:shadow-control-primary-hover";
const ICON_BUTTON =
  "w-9 border-transparent bg-transparent px-0 text-content shadow-none hover:border-transparent hover:bg-surface-hover hover:shadow-control-hover";
const SHORTCUT_KEY =
  "inline-flex h-5 min-w-5 items-center justify-center ml-px border border-shortcut-line rounded-[2px] bg-shortcut px-[5px] text-[10px] leading-none font-medium text-muted pointer-events-none";
const PRIMARY_SHORTCUT_KEY =
  "border-white/[22%] bg-white/[12%] text-white";

export function ToolbarButton({
  id,
  label,
  icon,
  onClick,
  disabled = false,
  shortcut,
  primary = false,
  iconOnly = false,
  title,
  status = "idle",
  pendingLabel = label,
  successLabel = "Done",
  errorLabel = "Try again",
  statusMessage
}: ToolbarButtonProps) {
  const labels: Record<ToolbarButtonStatus, string> = {
    idle: label,
    pending: pendingLabel,
    success: successLabel,
    error: errorLabel
  };
  const icons: Record<ToolbarButtonStatus, ComponentChildren> = {
    idle: icon,
    pending: <SpinnerIcon />,
    success: <CheckIcon />,
    error: <ErrorIcon />
  };
  const states: ToolbarButtonStatus[] = [
    "idle",
    "pending",
    "success",
    "error"
  ];
  const className = [
    BASE_BUTTON,
    iconOnly
      ? ICON_BUTTON
      : primary
        ? PRIMARY_BUTTON
        : SECONDARY_BUTTON,
    shortcut && "toolbar-button--shortcut pr-1.5",
    primary && "toolbar-button--primary",
    iconOnly && "toolbar-button--icon"
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      class={className}
      id={id}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-busy={status === "pending" ? "true" : undefined}
      data-status={status}
      title={title}
    >
      <span class="toolbar-button__icon grid size-[17px] shrink-0" aria-hidden="true">
        {states.map((state) => (
          <span
            class="col-start-1 row-start-1 grid size-full place-items-center transition-[opacity,transform,filter] duration-[140ms] data-[active=false]:pointer-events-none data-[active=false]:scale-[.86] data-[active=false]:opacity-0"
            data-active={status === state ? "true" : "false"}
            key={state}
          >
            {icons[state]}
          </span>
        ))}
      </span>
      {!iconOnly && (
        <span class="toolbar-button__label grid min-w-0" aria-hidden="true">
          {states.map((state) => (
            <span
              class="col-start-1 row-start-1 whitespace-nowrap transition-[opacity,transform,filter] duration-[140ms] data-[active=false]:pointer-events-none data-[active=false]:translate-y-[3px] data-[active=false]:scale-[.96] data-[active=false]:opacity-0"
              data-active={status === state ? "true" : "false"}
              key={state}
            >
              {labels[state]}
            </span>
          ))}
        </span>
      )}
      {shortcut && (
        <kbd
          class={`${SHORTCUT_KEY}${primary ? ` ${PRIMARY_SHORTCUT_KEY}` : ""}`}
          aria-hidden="true"
        >
          {shortcut}
        </kbd>
      )}
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status === "idle"
          ? ""
          : status === "error" && statusMessage
            ? statusMessage
            : labels[status]}
      </span>
    </button>
  );
}
