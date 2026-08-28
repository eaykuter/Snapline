const FALLBACK_DOMAIN = "screenshot";

export function buildFilename(
  sourceUrl: string,
  date = new Date()
): string {
  const domain = getSafeDomain(sourceUrl);
  const stamp = [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0")
  ].join("");
  return `${domain}-${stamp}.png`;
}

export function getSafeDomain(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const candidate =
      url.hostname ||
      url.protocol.replace(":", "") ||
      FALLBACK_DOMAIN;
    return sanitizeFilenamePart(candidate);
  } catch {
    return FALLBACK_DOMAIN;
  }
}

export function sanitizeFilenamePart(value: string): string {
  const clean = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .toLowerCase();

  return clean.slice(0, 80) || FALLBACK_DOMAIN;
}
