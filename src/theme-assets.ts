type ColorScheme = "light" | "dark";

function getIconPath(size: number, colorScheme: ColorScheme): string {
  const suffix = colorScheme === "dark" ? "-dark" : "";
  return `icons/icon${suffix}-${size}.png`;
}

export function getActionIconPaths(
  colorScheme: ColorScheme
): Record<number, string> {
  return {
    16: getIconPath(16, colorScheme),
    32: getIconPath(32, colorScheme),
    48: getIconPath(48, colorScheme),
    128: getIconPath(128, colorScheme)
  };
}

export function getFaviconPath(colorScheme: ColorScheme): string {
  return getIconPath(32, colorScheme);
}

export function syncThemeAssetsWithSystemPreference(): (() => void) | undefined {
  if (!window.matchMedia) {
    return;
  }

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const updateAssets = (): void => {
    const activeScheme = colorScheme.matches ? "dark" : "light";
    const faviconPath = getFaviconPath(activeScheme);
    const favicon =
      document.querySelector<HTMLLinkElement>("#snapline-favicon");
    if (favicon) {
      favicon.href =
        typeof chrome !== "undefined" && chrome.runtime?.getURL
          ? chrome.runtime.getURL(faviconPath)
          : `/${faviconPath}`;
    }

    if (typeof chrome === "undefined" || !chrome.action?.setIcon) {
      return;
    }

    void chrome.action
      .setIcon({
        path: getActionIconPaths(activeScheme)
      })
      .catch(() => undefined);
  };

  updateAssets();
  colorScheme.addEventListener("change", updateAssets);
  return () => colorScheme.removeEventListener("change", updateAssets);
}
