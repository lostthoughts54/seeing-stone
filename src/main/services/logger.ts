const SECRET_KEYS = /token|password|authorization|api[_-]?key|device[_-]?id|path|url/i;
const TOKEN_PATTERN = /([?&](?:api_key|token)=)[^&\s]+/gi;
const JSON_SECRET_PATTERN = /((?:"|')?(?:access[_-]?token|token|password|authorization|api[_-]?key|device[_-]?id|X-Emby-Authorization|X-MediaBrowser-Token)(?:"|')?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi;
const AUTH_PATTERN = /((?:X-Emby-Authorization|X-MediaBrowser-Token|Authorization)\s*[:=]\s*)[^\r\n]*/gi;
const JELLYFIN_TOKEN_PATTERN = /(\bToken\s*=\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi;
const SECRET_VALUE_PATTERN = /(\b(?:AccessToken|Password|ApiKey|DeviceId)\s*=\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi;
const FILE_URL_PATTERN = /\bfile:\/\/[^\r\n"'<>|]*/gi;
const QUOTED_WINDOWS_PATH_PATTERN = /(["'])(?:[A-Za-z]:[\\/]|\\\\)[^"'\r\n]*\1/g;
const WINDOWS_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]*/g;

export function redactText(value: string): string {
  return value
    .replace(TOKEN_PATTERN, "$1[REDACTED]")
    .replace(JSON_SECRET_PATTERN, "$1[REDACTED]")
    .replace(AUTH_PATTERN, "$1[REDACTED]")
    .replace(JELLYFIN_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(SECRET_VALUE_PATTERN, "$1[REDACTED]")
    .replace(FILE_URL_PATTERN, "[REDACTED_PATH]")
    .replace(QUOTED_WINDOWS_PATH_PATTERN, "$1[REDACTED_PATH]$1")
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
