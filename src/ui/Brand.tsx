interface BrandProps {
  placement: "popup" | "preview";
  id?: string;
}

const BASE_BRAND =
  "font-medium leading-none tracking-[-0.01em] text-muted select-none";

export function Brand({ placement, id }: BrandProps) {
  const placementClass =
    placement === "popup"
      ? "popup-brand text-[11px]"
      : "preview-brand absolute left-1/2 -translate-x-1/2 text-xs max-[1040px]:hidden";

  return (
    <span
      class={`${BASE_BRAND} ${placementClass}`}
      id={id}
      aria-hidden="true"
    >
      Snapline
    </span>
  );
}
