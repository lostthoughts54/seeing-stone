import { AppError } from "./errors";
import type { CompanionStateService } from "./companionState";

interface ArtworkApi {
  fetchArtwork(itemId: string, kind: string, options: Record<string, string>, signal?: AbortSignal): Promise<Response>;
}

const sizes = {
  small: { MaxWidth: "240", Quality: "85" },
  medium: { MaxWidth: "640", Quality: "88" },
  large: { MaxWidth: "1280", Quality: "90" },
} as const;

export class CompanionArtworkService {
  constructor(
    private readonly api: ArtworkApi,
    private readonly state: CompanionStateService,
  ) {}

  async get(reference: string, preset: keyof typeof sizes, head = false): Promise<{ body: Buffer | null; contentType: string }> {
    const itemId = this.state.resolveItemRef(reference);
    const response = await this.api.fetchArtwork(itemId, "Primary", sizes[preset], AbortSignal.timeout(15_000));
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(contentType)) {
      throw new AppError("ARTWORK_TYPE_BLOCKED", "That artwork type is unavailable.", 415);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 5 * 1024 * 1024) throw new AppError("ARTWORK_TOO_LARGE", "That artwork is too large.", 413);
    if (head) return { body: null, contentType };
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 5 * 1024 * 1024) throw new AppError("ARTWORK_TOO_LARGE", "That artwork is too large.", 413);
    return { body, contentType };
  }
}
