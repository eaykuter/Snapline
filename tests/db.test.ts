import { afterEach, describe, expect, it, vi } from "vitest";
import { putCapture } from "../src/db";
import type { CaptureRecord } from "../src/types";

describe("capture storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the write transaction to commit", async () => {
    const putRequest = {} as IDBRequest<undefined>;
    const store = {
      put: vi.fn(() => putRequest)
    } as unknown as IDBObjectStore;
    const transaction = {
      objectStore: vi.fn(() => store)
    } as unknown as IDBTransaction;
    const close = vi.fn();
    const database = {
      transaction: vi.fn(() => transaction),
      close
    } as unknown as IDBDatabase;
    const openRequest = {
      result: database
    } as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => openRequest)
    });

    let settled = false;
    const write = putCapture(testRecord).then(() => {
      settled = true;
    });
    openRequest.onsuccess?.call(openRequest, new Event("success"));
    await vi.waitFor(() => {
      expect(putRequest.onsuccess).toBeTypeOf("function");
    });

    putRequest.onsuccess?.call(putRequest, new Event("success"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();

    transaction.oncomplete?.call(transaction, new Event("complete"));
    await write;
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the database when transaction setup fails", async () => {
    const close = vi.fn();
    const database = {
      transaction: vi.fn(() => {
        throw new Error("transaction setup failed");
      }),
      close
    } as unknown as IDBDatabase;
    const openRequest = {
      result: database
    } as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => openRequest)
    });

    const write = putCapture(testRecord);
    openRequest.onsuccess?.call(openRequest, new Event("success"));

    await expect(write).rejects.toThrow("transaction setup failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

const testRecord: CaptureRecord = {
  id: "capture-id",
  blob: new Blob(["png"], { type: "image/png" }),
  filename: "example-20260730.png",
  mode: "visible",
  source: {
    tabId: 1,
    url: "https://example.com"
  },
  width: 1,
  height: 1,
  createdAt: 0
};
