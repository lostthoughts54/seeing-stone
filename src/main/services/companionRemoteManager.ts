import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Bonjour = require("bonjour-service");
import type {
  CompanionSettingsBridge,
  CompanionSettingsState,
} from "../../shared/companionContracts";
import type { ApplicationPreferencesService, StoredCompanionSettings } from "./applicationPreferences";
import { CompanionAuthenticationService } from "./companionAuthentication";
import type { CompanionCredentialStore } from "./companionCredentialStore";
import { AppError } from "./errors";
import { listCompanionNetworkAdapters, selectCompanionNetwork } from "./companionNetwork";
import { CompanionPairingService } from "./companionPairing";
import { CompanionServer } from "./companionServer";
import type { CompanionStateService } from "./companionState";
import type { PlaybackCommandService } from "./playbackCommandService";
import type { PlaybackQueueStore } from "./playbackQueue";
import type { CompanionArtworkService } from "./companionArtwork";

function newPort(): number {
  return 49152 + (randomBytes(2).readUInt16BE(0) % (65535 - 49152 + 1));
}

function newSuffix(): string {
  return randomBytes(5).toString("hex").slice(0, 8);
}

export class CompanionRemoteManager implements CompanionSettingsBridge {
  private settings: StoredCompanionSettings | null = null;
  private state: CompanionSettingsState["runtimeState"] = "disabled";
  private message: string | null = null;
  private server: CompanionServer | null = null;
  private boundAddress: string | null = null;
  private bonjour: Bonjour | null = null;
  private advertisement: { stop: CallableFunction } | null = null;
  private connectedDevices = 0;
  private connectedDeviceIds = new Set<string>();
  private readonly pairing = new CompanionPairingService();
  private readonly authentication: CompanionAuthenticationService;
  private readonly listeners = new Set<(state: CompanionSettingsState) => void>();

  constructor(
    private readonly preferences: ApplicationPreferencesService,
    private readonly credentials: CompanionCredentialStore,
    private readonly companionState: CompanionStateService,
    private readonly commands: PlaybackCommandService,
    private readonly queue: PlaybackQueueStore,
    private readonly artwork: CompanionArtworkService,
    private readonly identity: () => { serverId: string; userId: string },
    private readonly staticRoot: string,
  ) {
    this.authentication = new CompanionAuthenticationService(credentials, identity);
  }

  async activateAfterLogin(): Promise<void> {
    this.settings = await this.loadSettings();
    if (this.settings.enabled) await this.start().catch((error) => this.block(error));
    await this.emit();
  }

  async stopForSessionChange(): Promise<void> {
    this.pairing.cancel();
    this.authentication.reset();
    this.companionState.clear();
    this.queue.reset();
    await this.stopNetwork();
    this.state = this.settings?.enabled ? "starting" : "disabled";
    await this.emit();
  }

  async shutdown(): Promise<void> {
    this.pairing.cancel();
    this.authentication.reset();
    this.companionState.clear();
    this.queue.reset();
    await this.stopNetwork();
    this.state = "disabled";
  }

  async getStatus(): Promise<CompanionSettingsState> {
    this.settings ??= await this.loadSettings();
    const identity = this.safeIdentity();
    let devices: Awaited<ReturnType<CompanionCredentialStore["list"]>> = [];
    if (identity) {
      try {
        devices = await this.credentials.list(identity.serverId, identity.userId);
      } catch (error) {
        this.state = "security-blocked";
        this.message = error instanceof Error ? error.message : "Paired-device storage could not be opened safely.";
      }
    }
    const adapter = selectCompanionNetwork(this.settings.networkId);
    if (this.settings.enabled && !adapter && this.server) {
      await this.stopNetwork();
      this.state = "network-changed";
      this.message = "The selected private network changed. Select and confirm the current adapter.";
    }
    if (this.settings.enabled && adapter && this.server && this.boundAddress !== adapter.address) {
      await this.stopNetwork();
      await this.start().catch((error) => this.block(error));
    }
    const addresses = adapter ? this.addresses(adapter.address) : [];
    return {
      enabled: this.settings.enabled,
      runtimeState: this.state,
      addresses,
      preferredAddress: addresses[0] ?? null,
      port: this.settings.port,
      selectedNetworkId: this.settings.networkId,
      networks: listCompanionNetworkAdapters(),
      connectedDevices: this.connectedDevices,
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        connected: this.connectedDeviceIds.has(device.deviceId),
        pairedAt: device.pairedAt,
        lastUsedAt: device.lastUsedAt,
      })),
      pairing: this.pairing.getView(),
      message: this.message,
    };
  }

  async setEnabled(input: { enabled: boolean }): Promise<CompanionSettingsState> {
    this.settings ??= await this.loadSettings();
    if (input.enabled === this.settings.enabled && (input.enabled ? Boolean(this.server) : !this.server)) return this.getStatus();
    if (input.enabled) {
      if (!this.safeIdentity()) throw new AppError("COMPANION_LOGIN_REQUIRED", "Sign in before enabling Companion Remote.", 409);
      if (!await this.credentials.isAvailable()) throw new AppError("COMPANION_PROTECTED_STORAGE_REQUIRED", "Protected Windows storage is unavailable.", 503);
      const identity = this.identity();
      try {
        await this.credentials.list(identity.serverId, identity.userId);
      } catch (error) {
        this.block(error);
        await this.emit();
        throw error;
      }
      if (!this.settings.networkId) throw new AppError("COMPANION_NETWORK_REQUIRED", "Select and confirm a trusted private network first.", 409);
      this.settings = { ...this.settings, enabled: true };
      await this.preferences.setCompanionSettings(this.settings);
      await this.start();
    } else {
      this.settings = { ...this.settings, enabled: false };
      await this.preferences.setCompanionSettings(this.settings);
      await this.stopNetwork();
      this.queue.releasePendingReservation();
      this.companionState.clear();
      this.state = "disabled";
      this.message = null;
    }
    await this.emit();
    return this.getStatus();
  }

  async selectNetwork(input: { networkId: string }): Promise<CompanionSettingsState> {
    this.settings ??= await this.loadSettings();
    const adapter = selectCompanionNetwork(input.networkId);
    if (!adapter) throw new AppError("COMPANION_NETWORK_INVALID", "Select an available private IPv4 network.", 422);
    const wasEnabled = this.settings.enabled;
    this.settings = { ...this.settings, networkId: adapter.id };
    await this.preferences.setCompanionSettings(this.settings);
    if (wasEnabled) {
      await this.stopNetwork();
      await this.start();
    }
    await this.emit();
    return this.getStatus();
  }

  async beginPairing(): Promise<CompanionSettingsState> {
    if (!this.server || this.state !== "listening") throw new AppError("COMPANION_NOT_LISTENING", "Enable Companion Remote before pairing.", 409);
    const status = await this.getStatus();
    if (!status.preferredAddress) throw new AppError("COMPANION_ADDRESS_UNAVAILABLE", "No Companion address is available.", 503);
    await this.pairing.begin(status.preferredAddress);
    await this.emit();
    return this.getStatus();
  }

  async cancelPairing(): Promise<CompanionSettingsState> {
    this.pairing.cancel();
    await this.emit();
    return this.getStatus();
  }

  async renameDevice(input: { deviceId: string; name: string }): Promise<CompanionSettingsState> {
    const identity = this.identity();
    await this.credentials.rename(identity.serverId, identity.userId, input.deviceId, input.name);
    await this.emit();
    return this.getStatus();
  }

  async revokeDevice(input: { deviceId: string }): Promise<CompanionSettingsState> {
    const identity = this.identity();
    await this.credentials.revoke(identity.serverId, identity.userId, input.deviceId);
    this.authentication.revoke(input.deviceId);
    this.server?.closeDevice(input.deviceId);
    await this.emit();
    return this.getStatus();
  }

  async regeneratePort(input: { confirmed: true }): Promise<{ oldAddresses: string[]; newAddresses: string[]; state: CompanionSettingsState }> {
    if (input.confirmed !== true) {
      throw new AppError("COMPANION_PORT_CONFIRMATION_REQUIRED", "Existing bookmarks and Home Screen shortcuts use the old port and may need to be removed and added again.", 409);
    }
    this.settings ??= await this.loadSettings();
    const oldAddresses = (await this.getStatus()).addresses;
    const wasEnabled = this.settings.enabled;
    await this.stopNetwork();
    let port = newPort();
    while (port === this.settings.port) port = newPort();
    this.settings = { ...this.settings, port };
    await this.preferences.setCompanionSettings(this.settings);
    if (wasEnabled) await this.start();
    const state = await this.getStatus();
    await this.emit();
    return { oldAddresses, newAddresses: state.addresses, state };
  }

  subscribe(listener: (state: CompanionSettingsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async start(): Promise<void> {
    if (this.server) return;
    this.settings ??= await this.loadSettings();
    const adapter = selectCompanionNetwork(this.settings.networkId);
    if (!adapter) {
      this.state = "network-changed";
      this.message = "The selected private network is no longer available.";
      return;
    }
    this.state = "starting";
    this.message = null;
    const mdnsHost = `seeing-stone-${this.settings.hostSuffix}.local`;
    const hosts = [`${mdnsHost}:${this.settings.port}`, `${adapter.address}:${this.settings.port}`];
    const server = new CompanionServer({
      adapter,
      port: this.settings.port,
      hosts,
      staticRoot: resolve(this.staticRoot),
      identity: this.identity,
      pairing: this.pairing,
      authentication: this.authentication,
      credentials: this.credentials,
      state: this.companionState,
      commands: this.commands,
      queue: this.queue,
      artwork: this.artwork,
      onConnectionsChanged: (_socketCount, deviceIds) => {
        this.connectedDevices = deviceIds.size;
        this.connectedDeviceIds = new Set(deviceIds);
        void this.emit();
      },
      onDevicesChanged: () => void this.emit(),
    });
    try {
      await server.start();
      this.server = server;
      this.boundAddress = adapter.address;
      this.bonjour = new Bonjour({
        disableIPv6: true,
        interface: adapter.address,
      } as unknown as ConstructorParameters<typeof Bonjour>[0]);
      this.advertisement = this.bonjour.publish({
        name: `Seeing Stone ${this.settings.hostSuffix}`,
        type: "http",
        port: this.settings.port,
        host: mdnsHost,
        txt: { protocol: "1", port: String(this.settings.port) },
      });
      this.state = "listening";
    } catch (error) {
      await server.stop().catch(() => undefined);
      this.state = "firewall-unknown";
      this.message = "The selected port could not be opened. Check for a port collision and allow Seeing Stone on Private networks only.";
      throw error;
    }
  }

  private async stopNetwork(): Promise<void> {
    this.pairing.cancel();
    this.authentication.reset();
    const server = this.server;
    this.server = null;
    this.boundAddress = null;
    await server?.stop().catch(() => undefined);
    this.advertisement?.stop();
    this.advertisement = null;
    this.bonjour?.destroy();
    this.bonjour = null;
    this.connectedDevices = 0;
    this.connectedDeviceIds.clear();
  }

  private async loadSettings(): Promise<StoredCompanionSettings> {
    const existing = await this.preferences.getCompanionSettings();
    if (existing) return existing;
    const created = { enabled: false, networkId: null, port: newPort(), hostSuffix: newSuffix() };
    await this.preferences.setCompanionSettings(created);
    return created;
  }

  private addresses(address: string): string[] {
    if (!this.settings) return [];
    return [
      `http://seeing-stone-${this.settings.hostSuffix}.local:${this.settings.port}`,
      `http://${address}:${this.settings.port}`,
    ];
  }

  private safeIdentity(): { serverId: string; userId: string } | null {
    try { return this.identity(); } catch { return null; }
  }

  private block(error: unknown): void {
    this.state = "security-blocked";
    this.message = error instanceof Error ? error.message : "Companion Remote was blocked by a security invariant.";
  }

  private async emit(): Promise<void> {
    if (!this.listeners.size) return;
    const state = await this.getStatus();
    for (const listener of this.listeners) listener(state);
  }
}
