import type { CaptureRecord } from "./types";

const DATABASE_NAME = "snapline";
const DATABASE_VERSION = 1;
const STORE_NAME = "captures";
const MAX_RECORD_AGE_MS = 60 * 60 * 1000;

export async function putCapture(record: CaptureRecord): Promise<void> {
  await withDatabase(async (db) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    await Promise.all([
      requestToPromise(transaction.objectStore(STORE_NAME).put(record)),
      transactionDone(transaction)
    ]);
  });
}

export async function getCapture(
  id: string
): Promise<CaptureRecord | undefined> {
  return await withDatabase((db) =>
    requestToPromise<CaptureRecord | undefined>(
      db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(id)
    )
  );
}

export async function attachCaptureToPreview(
  captureId: string,
  previewTabId: number
): Promise<void> {
  const record = await getCapture(captureId);
  if (!record) {
    throw new Error("The screenshot disappeared before its preview opened.");
  }
  record.previewTabId = previewTabId;
  await putCapture(record);
}

export async function deleteCapturesForPreviewTab(
  previewTabId: number
): Promise<void> {
  await withDatabase(async (db) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const records = await requestToPromise<CaptureRecord[]>(store.getAll());

    for (const record of records) {
      if (record.previewTabId === previewTabId) {
        store.delete(record.id);
      }
    }

    await transactionDone(transaction);
  });
}

export async function deleteOrphanedPreviewCaptures(
  livePreviewTabIds: ReadonlySet<number>
): Promise<void> {
  await withDatabase(async (db) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const records = await requestToPromise<CaptureRecord[]>(store.getAll());

    for (const record of records) {
      if (
        record.previewTabId !== undefined &&
        !livePreviewTabIds.has(record.previewTabId)
      ) {
        store.delete(record.id);
      }
    }

    await transactionDone(transaction);
  });
}

export async function pruneCaptures(now = Date.now()): Promise<void> {
  await withDatabase(async (db) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const records = await requestToPromise<CaptureRecord[]>(store.getAll());

    for (const record of records) {
      if (
        record.previewTabId === undefined &&
        now - record.createdAt > MAX_RECORD_AGE_MS
      ) {
        store.delete(record.id);
      }
    }

    await transactionDone(transaction);
  });
}

async function withDatabase<T>(
  operation: (db: IDBDatabase) => Promise<T>
): Promise<T> {
  const db = await openDatabase();
  try {
    return await operation(db);
  } finally {
    db.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open screenshot storage."));
  });
}

function requestToPromise<T = undefined>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Screenshot storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Screenshot storage failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Screenshot storage was aborted."));
  });
}
