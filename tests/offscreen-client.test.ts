import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenCommand } from "../src/types";

const abortMessage: OffscreenCommand = {
  target: "offscreen",
  type: "FULL_ABORT",
  jobId: "test-job"
};

describe("offscreen document lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes the document when a processing session finishes", async () => {
    const chromeMocks = installChromeMocks();
    const { sendOffscreen, withOffscreenDocument } =
      await import("../src/offscreen-client");

    await withOffscreenDocument(() => sendOffscreen(abortMessage));

    expect(chromeMocks.createDocument).toHaveBeenCalledOnce();
    expect(chromeMocks.sendMessage).toHaveBeenCalledWith(abortMessage);
    expect(chromeMocks.closeDocument).toHaveBeenCalledOnce();
  });

  it("keeps the document open until concurrent sessions finish", async () => {
    const firstResponse = deferred<{ ok: true }>();
    const secondResponse = deferred<{ ok: true }>();
    const chromeMocks = installChromeMocks();
    chromeMocks.sendMessage
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const { sendOffscreen, withOffscreenDocument } =
      await import("../src/offscreen-client");

    const first = withOffscreenDocument(() => sendOffscreen(abortMessage));
    const second = withOffscreenDocument(() => sendOffscreen(abortMessage));
    await vi.waitFor(() => {
      expect(chromeMocks.sendMessage).toHaveBeenCalledTimes(2);
    });

    firstResponse.resolve({ ok: true });
    await first;
    expect(chromeMocks.closeDocument).not.toHaveBeenCalled();

    secondResponse.resolve({ ok: true });
    await second;
    expect(chromeMocks.closeDocument).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function installChromeMocks() {
  const createDocument = vi.fn(async () => undefined);
  const closeDocument = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => ({ ok: true as const }));
  vi.stubGlobal("chrome", {
    offscreen: {
      Reason: { BLOBS: "BLOBS" },
      createDocument,
      closeDocument
    },
    runtime: { sendMessage }
  });
  return { createDocument, closeDocument, sendMessage };
}
