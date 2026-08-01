import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import type { CompanionPairingView } from "../../shared/companionContracts";
import { AppError } from "./errors";

interface ActivePairing {
  ticketHash: Buffer;
  codeHash: Buffer;
  code: string;
  expiresAt: number;
  failures: number;
  address: string;
  qrDataUrl: string;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: Buffer, value: string): boolean {
  const right = hash(value);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class CompanionPairingService {
  private active: ActivePairing | null = null;

  async begin(address: string): Promise<{ ticket: string; view: CompanionPairingView }> {
    const ticket = randomBytes(32).toString("base64url");
    const code = String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, "0");
    const expiresAt = Date.now() + 5 * 60_000;
    const pairingUrl = `${address}/#/pair?ticket=${ticket}`;
    const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360,
      color: { dark: "#17111f", light: "#ffffff" },
    });
    this.active = {
      ticketHash: hash(ticket),
      codeHash: hash(code),
      code,
      expiresAt,
      failures: 0,
      address,
      qrDataUrl,
    };
    return { ticket, view: this.getView()! };
  }

  getView(): CompanionPairingView | null {
    if (!this.active || this.active.expiresAt <= Date.now()) {
      this.active = null;
      return null;
    }
    return {
      code: this.active.code,
      expiresAt: new Date(this.active.expiresAt).toISOString(),
      address: this.active.address,
      qrDataUrl: this.active.qrDataUrl,
    };
  }

  consume(input: { ticket?: string; code?: string }): void {
    const active = this.active;
    if (!active || active.expiresAt <= Date.now()) {
      this.active = null;
      throw new AppError("COMPANION_PAIRING_EXPIRED", "The pairing code expired.", 410);
    }
    const accepted = input.ticket ? equal(active.ticketHash, input.ticket)
      : input.code ? equal(active.codeHash, input.code) : false;
    if (!accepted) {
      active.failures += 1;
      if (active.failures >= 5) this.active = null;
      throw new AppError("COMPANION_PAIRING_INVALID", "The pairing code is invalid.", 401);
    }
    this.active = null;
  }

  cancel(): void {
    this.active = null;
  }
}
