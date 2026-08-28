import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker
} from "@playwright/test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let context: BrowserContext | undefined;
let page: Page | undefined;
let extensionWorker: Worker | undefined;
let temporaryRoot: string | undefined;
let extensionId: string | undefined;
let browserIssues: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "snapline-e2e-"));
  const extensionPath = join(temporaryRoot, "extension");
  const profilePath = join(temporaryRoot, "profile");
  const crashPath = join(temporaryRoot, "crashpad");
  cpSync(resolve("dist"), extensionPath, { recursive: true });

  const manifestPath = join(extensionPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Test-only substitute for the activeTab grant normally supplied by a real
  // toolbar click or keyboard command.
  manifest.host_permissions = ["<all_urls>"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: false,
    viewport: null,
    args: [
      "--disable-crash-reporter",
      "--window-size=1200,800",
      `--crash-dumps-dir=${crashPath}`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  context.on("page", watchPage);
  for (const openPage of context.pages()) {
    watchPage(openPage);
  }
  extensionWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(extensionWorker.url()).host;
  page = await context.newPage();
  await page.goto("http://127.0.0.1:4178");
});

test.afterEach(() => {
  expect(browserIssues, browserIssues.join("\n")).toEqual([]);
  browserIssues = [];
});

test.afterAll(async () => {
  await context?.close();
  if (temporaryRoot) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("popup keeps full-page progress in browser chrome", async () => {
  if (!context || !extensionWorker || !extensionId) {
    throw new Error("The extension browser did not start.");
  }

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.emulateMedia({ colorScheme: "light" });
  const lightStyles = await popup.locator(".capture-action").first().evaluate(
    async (button) => {
      await document.fonts.ready;
      const fontResponse = await fetch(
        chrome.runtime.getURL("fonts/ibm-plex-sans-regular.woff2")
      );
      let fontLoadError = "";
      try {
        await document.fonts.load('400 13px "IBM Plex Sans"', "Capture");
      } catch (error) {
        fontLoadError =
          error instanceof Error ? error.message : String(error);
      }
      const shortcut = button.querySelector("kbd");
      if (!shortcut) {
        throw new Error("The capture shortcut is missing.");
      }
      return {
        buttonBackground: getComputedStyle(button).backgroundColor,
        buttonRadius: getComputedStyle(button).borderRadius,
        shortcutText: shortcut.textContent,
        shortcutBackground: getComputedStyle(shortcut).backgroundColor,
        shortcutPadding: getComputedStyle(shortcut).padding,
        fontFamily: getComputedStyle(button).fontFamily,
        fontLoaded: document.fonts.check('400 13px "IBM Plex Sans"'),
        fontLoadError,
        fontResponse: {
          ok: fontResponse.ok,
          status: fontResponse.status,
          type: fontResponse.headers.get("content-type")
        },
        fontFaces: Array.from(document.fonts).map((face) => ({
          family: face.family,
          status: face.status,
          weight: face.weight
        })),
        colorScheme: getComputedStyle(document.documentElement).colorScheme
      };
    }
  );
  expect(lightStyles.colorScheme).toBe("light");
  expect(lightStyles.buttonRadius).toBe("3px");
  expect(lightStyles.shortcutText).toBe("⌥ ⇧ A");
  expect(lightStyles.shortcutBackground).not.toBe(
    lightStyles.buttonBackground
  );
  expect(lightStyles.shortcutPadding).toBe("0px 5px");
  expect(lightStyles.fontFamily).toContain("IBM Plex Sans");
  expect(lightStyles.fontLoaded, JSON.stringify(lightStyles, null, 2)).toBe(
    true
  );
  await expect(popup.locator(".popup-brand")).toHaveText("Snapline");
  await popup.locator(".capture-action").first().hover();
  await popup.waitForTimeout(180);
  const popupHover = await popup.locator(".capture-action").first().evaluate(
    (button) => {
      const style = getComputedStyle(button);
      return {
        shadow: style.boxShadow,
        transform: style.transform,
        properties: style.transitionProperty,
        durations: style.transitionDuration
      };
    }
  );
  expect(popupHover.shadow).not.toBe("none");
  expect(popupHover.transform).toBe("none");
  expect(popupHover.properties).toContain("box-shadow");
  expect(
    popupHover.durations
      .split(",")
      .map((duration) => duration.trim())
      .every((duration) => duration === "0.14s")
  ).toBe(true);

  const iconCornerAlpha = await popup.evaluate(async () => {
    const icon = new Image();
    icon.src = chrome.runtime.getURL("icons/icon-128.png");
    await icon.decode();
    const canvas = document.createElement("canvas");
    canvas.width = icon.naturalWidth;
    canvas.height = icon.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Icon audit canvas is unavailable.");
    }
    context.drawImage(icon, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(iconCornerAlpha).toBe(0);
  const darkIconCenter = await popup.evaluate(async () => {
    const icon = new Image();
    icon.src = chrome.runtime.getURL("icons/icon-dark-128.png");
    await icon.decode();
    const canvas = document.createElement("canvas");
    canvas.width = icon.naturalWidth;
    canvas.height = icon.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Dark icon audit canvas is unavailable.");
    }
    context.drawImage(icon, 0, 0);
    return [...context.getImageData(64, 64, 1, 1).data];
  });
  expect(darkIconCenter).toEqual([24, 24, 27, 255]);

  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.reload();
  const darkStyles = await popup.locator(".capture-action").first().evaluate(
    (button) => ({
      background: getComputedStyle(button).backgroundColor,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      mediaMatches: matchMedia("(prefers-color-scheme: dark)").matches
    })
  );
  expect(darkStyles.colorScheme).toBe("dark");
  expect(darkStyles.mediaMatches).toBe(true);
  expect(darkStyles.background).not.toBe(lightStyles.buttonBackground);

  await extensionWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "FULL_CAPTURE_PROGRESS",
      jobId: "progress-ui-test",
      phase: "capturing",
      current: 2,
      total: 4
    });
  });

  await expect(popup.locator(".capture-list")).toBeHidden();
  await expect(popup.locator("#full-progress")).toBeVisible();
  await expect(popup.locator("#full-progress-label")).toHaveText(
    "Capturing 2 of 4"
  );
  await expect(popup.locator("#full-progress-track")).toHaveAttribute(
    "aria-valuenow",
    "44"
  );
  await expect(popup.locator("#full-progress-cancel")).toBeVisible();
  const progressBox = await popup.locator("#full-progress").boundingBox();
  expect(progressBox?.height).toBeLessThanOrEqual(60);
  await expect(popup.locator("#full-progress")).toHaveCSS(
    "border-radius",
    "0px"
  );
  const progressColors = await popup.locator("#full-progress").evaluate(
    (progress) => ({
      accent: getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim(),
      dot: getComputedStyle(
        progress.querySelector(".full-progress__indicator")!
      ).backgroundColor,
      fill: getComputedStyle(
        progress.querySelector(".full-progress__fill")!
      ).backgroundColor
    })
  );
  expect(progressColors.dot).toBe(progressColors.fill);
  expect(progressColors.accent).toBe("#2563eb");

  await extensionWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "FULL_CAPTURE_PROGRESS",
      jobId: "progress-ui-test",
      phase: "encoding"
    });
  });
  await expect(popup.locator("#full-progress")).toHaveAttribute(
    "data-phase",
    "encoding"
  );
  await expect(popup.locator("#full-progress-label")).toHaveText(
    "Processing screenshot…"
  );
  await expect(popup.locator("#full-progress-track")).not.toHaveAttribute(
    "aria-valuenow"
  );
  await expect(popup.locator("#full-progress-track")).toHaveAttribute(
    "aria-valuetext",
    "Processing screenshot"
  );
  await expect(popup.locator("#full-progress-cancel")).toBeDisabled();
  await expect(popup.locator("#full-progress-fill")).not.toHaveCSS(
    "animation-name",
    "none"
  );

  await extensionWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "FULL_CAPTURE_PROGRESS",
      jobId: "progress-ui-test",
      phase: "cancelled"
    });
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "STILL_CAPTURE_PROGRESS",
      jobId: "still-progress-ui-test",
      mode: "visible",
      phase: "capturing"
    });
  });
  await expect(popup.locator("#still-progress")).toBeVisible();
  await expect(popup.locator("#still-progress-label")).toHaveText(
    "Capturing visible page…"
  );
  await expect(popup.locator("#still-progress-track")).toHaveAttribute(
    "aria-valuetext",
    "Capturing visible page"
  );
  await expect(popup.locator("#still-progress-fill")).not.toHaveCSS(
    "animation-name",
    "none"
  );

  await extensionWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "STILL_CAPTURE_PROGRESS",
      jobId: "still-progress-ui-test",
      mode: "visible",
      phase: "processing"
    });
  });
  await expect(popup.locator("#still-progress-label")).toHaveText(
    "Processing screenshot…"
  );
  await popup.close();

  const compatibilityPopup = await context.newPage();
  await compatibilityPopup.addInitScript(() => {
    Object.defineProperty(chrome.commands, "getAll", {
      configurable: true,
      value: async () => [
        { name: "capture-area", shortcut: "", description: "" },
        { name: "capture-visible", shortcut: "Alt+Shift+V", description: "" },
        { name: "capture-full", shortcut: "Alt+Shift+F", description: "" }
      ]
    });
  });
  await compatibilityPopup.goto(
    `chrome-extension://${extensionId}/popup.html`
  );
  await expect(compatibilityPopup.locator("kbd").first()).toHaveText("⌥ ⇧ A");
  await expect(compatibilityPopup.locator("kbd").nth(1)).toHaveText("⌥ ⇧ V");
  await expect(compatibilityPopup.locator("kbd").nth(2)).toHaveText("⌥ ⇧ F");
  await compatibilityPopup.close();

  const themedPopup = await context.newPage();
  await themedPopup.addInitScript(() => {
    Object.defineProperty(chrome.action, "setIcon", {
      configurable: true,
      value: async (details: chrome.action.TabIconDetails) => {
        (
          globalThis as typeof globalThis & {
            __snaplineActionIcon?: chrome.action.TabIconDetails["path"];
          }
        ).__snaplineActionIcon = details.path;
      }
    });
  });
  await themedPopup.emulateMedia({ colorScheme: "dark" });
  await themedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect
    .poll(() =>
      themedPopup.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __snaplineActionIcon?: chrome.action.TabIconDetails["path"];
            }
          ).__snaplineActionIcon
      )
    )
    .toEqual({
      16: "icons/icon-dark-16.png",
      32: "icons/icon-dark-32.png",
      48: "icons/icon-dark-48.png",
      128: "icons/icon-dark-128.png"
    });
  await expect(themedPopup.locator("#snapline-favicon")).toHaveAttribute(
    "href",
    /\/icons\/icon-dark-32\.png$/
  );

  await themedPopup.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() =>
      themedPopup.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __snaplineActionIcon?: chrome.action.TabIconDetails["path"];
            }
          ).__snaplineActionIcon
      )
    )
    .toEqual({
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png"
    });
  await expect(themedPopup.locator("#snapline-favicon")).toHaveAttribute(
    "href",
    /\/icons\/icon-32\.png$/
  );
  await themedPopup.close();
});

test("area capture opens the selector and produces a preview", async () => {
  if (!context || !page) {
    throw new Error("The extension browser did not start.");
  }
  await page.bringToFront();
  await requestCapture("area", page);
  await expect(page.locator('[data-snapline-ui="area"]')).toBeAttached();

  const target = page.locator("[data-test-target]");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }

  const previewPromise = context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("preview.html")
  });
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10);
  const selectorState = await page
    .locator('[data-snapline-ui="area"]')
    .evaluate((host) => {
      const veil = host.shadowRoot?.querySelector(".veil");
      const size = host.shadowRoot?.querySelector(".size");
      if (!(veil instanceof HTMLElement) || !(size instanceof HTMLElement)) {
        throw new Error("The selector surface is incomplete.");
      }
      return {
        dimensions: size.textContent ?? "",
        veil: getComputedStyle(veil).backgroundColor
      };
  });
  expect(selectorState.veil).toBe("rgba(9, 9, 11, 0.6)");
  await page.mouse.up();

  const preview = await previewPromise;
  await expect(preview.locator("#preview-image")).toBeVisible();
  await expect(preview.locator("#capture-meta")).toHaveText(
    /Selected area · [\d,]+ × [\d,]+ · PNG/
  );
  await expect(preview.locator("#capture-filename")).toHaveText(
    /^127\.0\.0\.1-\d{8}\.png$/
  );
  const previewDimensions = await preview.locator("#preview-image").evaluate(
    (element) => {
      if (!(element instanceof HTMLImageElement)) {
        throw new Error("Preview image is unavailable.");
      }
      return {
        width: element.naturalWidth,
        height: element.naturalHeight
      };
    }
  );
  const selectedDimensions = selectorState.dimensions
    .split("×")
    .map((value) => Number.parseInt(value.trim(), 10));
  expect(
    Math.abs((selectedDimensions[0] ?? 0) - previewDimensions.width)
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((selectedDimensions[1] ?? 0) - previewDimensions.height)
  ).toBeLessThanOrEqual(1);

  const captureUrl = preview.url();
  const captureFilename =
    (await preview.locator("#capture-filename").textContent()) ?? "";
  await preview.reload();
  await expect(preview.locator("#preview-image")).toBeVisible();
  await expect(preview.locator("#capture-filename")).toHaveText(captureFilename);
  await expect(preview.locator("#retake-button kbd")).toHaveText("R");
  await expect(preview.locator("#copy-button kbd")).toHaveText("C");
  await expect(preview.locator("#download-button kbd")).toHaveText("D");
  await expect(preview.locator("#preview-brand")).toHaveText("Snapline");
  const brandPosition = await preview.locator("#preview-brand").evaluate(
    (brand) => {
      const bounds = brand.getBoundingClientRect();
      const title = document
        .querySelector(".preview-title")
        ?.getBoundingClientRect();
      const actions = document
        .querySelector(".preview-actions")
        ?.getBoundingClientRect();
      return {
        center: bounds.left + bounds.width / 2,
        viewportCenter: window.innerWidth / 2,
        clearOfTitle: title ? title.right < bounds.left : false,
        clearOfActions: actions ? bounds.right < actions.left : false
      };
    }
  );
  expect(
    Math.abs(brandPosition.center - brandPosition.viewportCenter)
  ).toBeLessThanOrEqual(0.5);
  expect(brandPosition.clearOfTitle).toBe(true);
  expect(brandPosition.clearOfActions).toBe(true);

  const actionTransitions = await preview
    .locator(".toolbar-button:not(.toolbar-button--icon)")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const style = getComputedStyle(button);
        return {
          property: style.transitionProperty,
          duration: style.transitionDuration
        };
      })
    );
  for (const transition of actionTransitions) {
    expect(transition.property).toContain("box-shadow");
    expect(
      transition.duration
        .split(",")
        .map((duration) => duration.trim())
        .every((duration) => duration === "0.14s")
    ).toBe(true);
  }

  await preview.bringToFront();
  const copyButton = preview.locator("#copy-button");
  const copyBefore = await copyButton.boundingBox();
  await preview.keyboard.press("c");
  await expect(copyButton).toHaveAttribute("data-status", "success");
  await expect(
    copyButton.locator('.toolbar-button__label [data-active="true"]')
  ).toHaveText("Copied");
  const copyAfter = await copyButton.boundingBox();
  expect(copyBefore).not.toBeNull();
  expect(copyAfter).not.toBeNull();
  expect(
    Math.abs((copyAfter?.width ?? 0) - (copyBefore?.width ?? 0))
  ).toBeLessThanOrEqual(0.5);
  await expect(preview.locator("#toast")).toHaveCount(0);
  await preview.setViewportSize({ width: 760, height: 800 });
  await preview.keyboard.press("c");
  await expect(copyButton).toHaveAttribute("data-status", "success");
  await expect(
    copyButton.locator('.toolbar-button__label [data-active="true"]')
  ).toHaveText("Copied");
  await preview.setViewportSize({ width: 1200, height: 800 });
  await preview.bringToFront();
  const downloadPromise = preview.waitForEvent("download");
  await preview.keyboard.press("d");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(captureFilename);
  await expect(preview.locator("#download-button")).toHaveAttribute(
    "data-status",
    "success"
  );
  await expect(
    preview.locator(
      '#download-button .toolbar-button__label [data-active="true"]'
    )
  ).toHaveText("Started");

  const stillColor = await preview.locator("#preview-image").evaluate(
    (element) => {
      if (!(element instanceof HTMLImageElement)) {
        throw new Error("Preview image is unavailable.");
      }
      const displayP3Context = document
        .createElement("canvas")
        .getContext("2d", { colorSpace: "display-p3" });
      return {
        displayP3Supported:
          displayP3Context?.getContextAttributes().colorSpace === "display-p3",
        pngUrl: element.src
      };
    }
  );
  if (stillColor.displayP3Supported) {
    const colorChunks = await readPngChunks(preview, stillColor.pngUrl);
    expect(
      colorChunks.some(
        (chunk) => chunk.type === "cICP" || chunk.type === "iCCP"
      ),
      `Expected a wide-gamut PNG profile; received ${colorChunks
        .map((chunk) => chunk.type)
        .join(", ")}`
    ).toBe(true);
  }
  await preview.emulateMedia({ colorScheme: "dark" });
  await expect(preview.locator("#snapline-favicon")).toHaveAttribute(
    "href",
    /\/icons\/icon-dark-32\.png$/
  );
  await preview.locator("#copy-button").hover();
  await expect(preview.locator("#copy-button")).toHaveCSS(
    "background-color",
    "rgb(39, 39, 42)"
  );
  const previewDarkStyles = await preview.evaluate(() => ({
    stage: getComputedStyle(document.body).backgroundColor,
    copyHover: getComputedStyle(
      document.getElementById("copy-button")!
    ).backgroundColor,
    copyTransform: getComputedStyle(
      document.getElementById("copy-button")!
    ).transform,
    copyHoverShadow: getComputedStyle(
      document.getElementById("copy-button")!
    ).boxShadow,
    download: getComputedStyle(
      document.getElementById("download-button")!
    ).backgroundColor,
    downloadShadow: getComputedStyle(
      document.getElementById("download-button")!
    ).boxShadow,
    closeBorder: getComputedStyle(
      document.getElementById("close-button")!
    ).borderColor,
    fontFamily: getComputedStyle(document.body).fontFamily
  }));
  expect(previewDarkStyles.stage).toBe("rgb(9, 9, 11)");
  expect(previewDarkStyles.copyHover).toBe("rgb(39, 39, 42)");
  expect(previewDarkStyles.copyTransform).toBe("none");
  expect(previewDarkStyles.copyHoverShadow).not.toBe("none");
  expect(previewDarkStyles.download).toBe("rgb(37, 99, 235)");
  expect(previewDarkStyles.downloadShadow).not.toBe("none");
  expect(previewDarkStyles.closeBorder).toBe("rgba(0, 0, 0, 0)");
  expect(previewDarkStyles.fontFamily).toContain("IBM Plex Sans");
  await preview.keyboard.press("c");
  await expect(preview.locator("#copy-button")).toHaveAttribute(
    "data-status",
    "success"
  );
  await expect(
    preview.locator(
      '#copy-button .toolbar-button__label [data-active="true"]'
    )
  ).toHaveText("Copied");
  await expect(preview.locator("#toast")).toHaveCount(0);
  await preview.locator("#download-button").hover();
  await preview.waitForTimeout(180);
  const downloadHover = await preview
    .locator("#download-button")
    .evaluate((button) => ({
      shadow: getComputedStyle(button).boxShadow,
      transform: getComputedStyle(button).transform
    }));
  expect(downloadHover.shadow).not.toBe("none");
  expect(downloadHover.transform).toBe("none");
  await expect(preview.locator(".preview-actions > button")).toHaveCount(4);
  await expect(preview.locator(".preview-actions > button").nth(0)).toHaveId(
    "retake-button"
  );
  await expect(preview.locator(".preview-actions > button").nth(1)).toHaveId(
    "copy-button"
  );
  await preview.close();
  await page.waitForTimeout(120);

  const expiredPreview = await context.newPage();
  await expiredPreview.goto(captureUrl);
  await expect(expiredPreview.locator("#preview-error")).toBeVisible();
  await expect(expiredPreview.locator("#preview-error-message")).toContainText(
    "expired"
  );
  await expiredPreview.close();
});

test("retake reactivates the source tab before capturing", async () => {
  if (!context || !page) {
    throw new Error("The extension browser did not start.");
  }

  await page.goto("http://127.0.0.1:4178");
  await page.bringToFront();
  const firstPreviewPromise = context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("preview.html")
  });
  await requestCapture("visible", page);
  const firstPreview = await firstPreviewPromise;
  await expect(firstPreview.locator("#preview-image")).toBeVisible();

  const secondPreviewPromise = context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("preview.html")
  });
  await firstPreview.keyboard.press("r");
  const secondPreview = await secondPreviewPromise;
  await expect(secondPreview.locator("#preview-image")).toBeVisible();
  await expect(secondPreview.locator("#capture-meta")).toHaveText(
    /Visible page · [\d,]+ × [\d,]+ · PNG/
  );
  await secondPreview.close();
});

test("full-page harness restores page state and cancellation", async () => {
  if (!page) {
    throw new Error("The extension browser did not start.");
  }

  await page.goto("http://127.0.0.1:4178/full");
  await expect(page.locator("#result")).toHaveAttribute("data-state", "pass", {
    timeout: 10_000
  });
  await expect(page.locator("#result")).toContainText(
    "Full-page DOM and cancellation restored"
  );
});

test("full page loads lazy content and excludes the page scrollbar", async () => {
  if (!context || !page) {
    throw new Error("The extension browser did not start.");
  }

  await page.goto("http://127.0.0.1:4178");
  const expected = await page.evaluate(() => {
    const image = document.getElementById("lazy-image");
    if (!(image instanceof HTMLImageElement)) {
      throw new Error("Lazy fixture image is missing.");
    }
    const rect = image.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      devicePixelRatio: window.devicePixelRatio,
      lazyX: rect.left + rect.width / 2,
      lazyY: rect.top + window.scrollY + rect.height / 2
    };
  });

  await page.bringToFront();
  const previewPromise = context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("preview.html")
  });
  await requestCapture("full", page);
  const preview = await previewPromise;
  await expect(preview.locator("#preview-image")).toBeVisible({
    timeout: 20_000
  });
  await expect(preview.locator("#capture-meta")).toHaveText(
    /Full page · [\d,]+ × [\d,]+ · PNG/
  );

  const pixels = await preview.locator("#preview-image").evaluate(
    (element, input) => {
      if (!(element instanceof HTMLImageElement)) {
        throw new Error("Preview image is unavailable.");
      }
      const scaleX = element.naturalWidth / input.viewportWidth;
      const scaleY = element.naturalHeight / input.documentHeight;
      const canvas = document.createElement("canvas");
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Canvas context is unavailable.");
      }
      context.drawImage(element, 0, 0);
      const displayP3Context = document
        .createElement("canvas")
        .getContext("2d", { colorSpace: "display-p3" });
      return {
        width: element.naturalWidth,
        height: element.naturalHeight,
        expectedHeight: Math.round(
          input.documentHeight * input.devicePixelRatio
        ),
        rightEdge: Array.from(
          context.getImageData(
            element.naturalWidth - 1,
            Math.round(200 * scaleY),
            1,
            1
          ).data
        ),
        lazyCenter: Array.from(
          context.getImageData(
            Math.round(input.lazyX * scaleX),
            Math.round(input.lazyY * scaleY),
            1,
            1
          ).data
        ),
        displayP3Supported:
          displayP3Context?.getContextAttributes().colorSpace === "display-p3",
        pngUrl: element.src
      };
    },
    expected
  );

  expect(
    Math.abs(pixels.height - pixels.expectedHeight),
    JSON.stringify({ pixels, expected })
  ).toBeLessThanOrEqual(1);
  expect(pixels.rightEdge.slice(0, 3)).toEqual([239, 246, 255]);
  expectColorClose(pixels.lazyCenter.slice(0, 3), [22, 163, 74], 1);
  if (pixels.displayP3Supported) {
    const colorChunks = await readPngChunks(preview, pixels.pngUrl);
    expect(colorChunks.find((chunk) => chunk.type === "cICP")?.data).toEqual(
      [12, 13, 0, 1]
    );
  }
  await preview.close();
});

function expectColorClose(
  actual: number[],
  expected: number[],
  tolerance: number
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((channel, index) => {
    expect(
      Math.abs(channel - (expected[index] ?? 0)),
      `channel ${index}: expected ${expected[index]}, received ${channel}`
    ).toBeLessThanOrEqual(tolerance);
  });
}

function watchPage(target: Page): void {
  target.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserIssues.push(
        `${message.type()} at ${target.url() || "about:blank"}: ${message.text()}`
      );
    }
  });
  target.on("pageerror", (error) => {
    browserIssues.push(
      `pageerror at ${target.url() || "about:blank"}: ${error.message}`
    );
  });
}

async function readPngChunks(
  targetPage: Page,
  pngUrl: string
): Promise<Array<{ type: string; data: number[] }>> {
  return await targetPage.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const chunks: Array<{ type: string; data: number[] }> = [];
    let offset = 8;
    while (offset + 12 <= bytes.byteLength) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
      const length = view.getUint32(0);
      const type = new TextDecoder().decode(
        bytes.subarray(offset + 4, offset + 8)
      );
      chunks.push({
        type,
        data: Array.from(bytes.subarray(offset + 8, offset + 8 + length))
      });
      offset += 12 + length;
    }
    return chunks;
  }, pngUrl);
}

async function requestCapture(
  mode: "area" | "visible" | "full",
  sourcePage: Page
): Promise<void> {
  if (!context) {
    throw new Error("The extension browser did not start.");
  }
  await sourcePage.bringToFront();
  extensionWorker ??=
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));

  const sourceTabId = await extensionWorker.evaluate(async () => {
    const [source] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (source?.id === undefined) {
      throw new Error("Could not find the active source tab.");
    }
    return source.id;
  });

  if (!extensionId) {
    throw new Error("The extension id is unavailable.");
  }
  const commandPage = await context.newPage();
  await commandPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const response = await commandPage.evaluate(
    async ({ captureMode, tabId }) => {
      return await chrome.runtime.sendMessage({
        target: "background",
        type: "START_CAPTURE",
        mode: captureMode,
        tabId
      });
    },
    { captureMode: mode, tabId: sourceTabId }
  );
  await commandPage.close();

  expect(response.ok, response.error?.message).toBe(true);
}
