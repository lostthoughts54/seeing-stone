const SECRET_KEYS = /token|password|authorization|api[_-]?key|path|url/i;
const TOKEN_PATTERN = /([?&](?:api_key|token)=)[^&\s]+/gi;
const AUTH_PATTERN = /((?:X-Emby-Authorization|X-MediaBrowser-Token|Authorization)\s*[:=]\s*)[^,\s]+/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s"']+\\)*[^\s"']*/g;

export function redactText(value: string): string {
  return value
    .replace(TOKEN_PATTERN, "$1[REDACTED]")
    .replace(AUTH_PATTERN, "$1[REDACTED]")
    .replace(WINDOWS_PATH_PATTERN, "[REDACTED_PATH]");
}

export function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : sanitizeLogValue(entry);
    }
    return result;
  }
  return value;
}

export interface AppLogger {
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

export const logger: AppLogger = {
  info(message, metadata) {
    console.info(redactText(message), metadata === undefined ? "" : sanitizeLogValue(metadata));
  },
  warn(message, metadata) {
    console.warn(redactText(message), metadata === undefined ? "" : sanitizeLogValue(metadata));
  },
  error(message, metadata) {
    console.error(redactText(message), metadata === undefined ? "" : sanitizeLogValue(metadata));
  },
};
