import type {
  CommandResult,
  OffscreenCommand,
  ProcessResult
} from "./types";

let creatingDocument: Promise<void> | undefined;
let closingDocument: Promise<void> | undefined;
let activeSessions = 0;

export async function withOffscreenDocument<T>(
  operation: () => Promise<T>
): Promise<T> {
  activeSessions += 1;

  try {
    return await operation();
  } finally {
    activeSessions -= 1;
    if (activeSessions === 0) {
      await closeOffscreenDocument();
    }
  }
}

export async function sendOffscreen<T = ProcessResult>(
  message: OffscreenCommand
): Promise<CommandResult<T>> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage(message)) as CommandResult<T>;
}

async function closeOffscreenDocument(): Promise<void> {
  if (creatingDocument) {
    await creatingDocument.catch(() => undefined);
    if (activeSessions > 0) {
      return;
    }
  }
  if (closingDocument) {
    await closingDocument;
    return;
  }

  closingDocument = chrome.offscreen.closeDocument().catch(() => {
    // Closing is best-effort: Chrome may already have discarded the document.
  });
  try {
    await closingDocument;
  } finally {
    closingDocument = undefined;
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (closingDocument) {
    await closingDocument;
  }
  if (creatingDocument) {
    await creatingDocument;
    return;
  }

  creatingDocument = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification:
          "Decode screenshot tiles, stream PNG data, and store the local preview."
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/single offscreen|already exists/i.test(message)) {
        throw error;
      }
    }
  })();

  try {
    await creatingDocument;
  } finally {
    creatingDocument = undefined;
  }
}
