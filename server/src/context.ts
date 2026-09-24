import type { WaStatus } from '../../shared/api.js';
import type { Config } from './config.js';
import { DataWriter } from './crypto/keyring.js';
import type { Repo } from './db/repo.js';
import type { EventBus } from './events.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';

/** Control surface of the WhatsApp integration, used by the HTTP layer. */
export interface WaController {
  status(): WaStatus;
  /** Idempotent. Starts connecting to Chromium / WhatsApp Web. */
  start(): Promise<void>;
  restart(): Promise<void>;
  /** Unlinks this device from the WhatsApp account. */
  logout(): Promise<void>;
  /** Re-queues a media download. Returns false if the message has no retryable media. */
  retryMedia(messageId: string): boolean;
  stop(): Promise<void>;
}

export class AppContext {
  private writerInstance: DataWriter | null = null;
  wa: WaController;
  /** Every registered route (filled by an onRoute hook) — used by the auth coverage test. */
  readonly routeTable: { method: string; url: string; public: boolean }[] = [];

  constructor(
    readonly config: Config,
    readonly log: Logger,
    readonly repo: Repo,
    readonly events: EventBus,
    readonly settings: SettingsStore,
    wa?: WaController,
  ) {
    this.wa = wa ?? new NullWa();
  }

  /** The encryptor for new data; null until an owner (and thus a public key) exists. */
  writer(): DataWriter | null {
    if (this.writerInstance) return this.writerInstance;
    const owner = this.repo.getOwner();
    if (!owner) return null;
    this.writerInstance = new DataWriter(this.repo, owner.public_key);
    return this.writerInstance;
  }

  mediaMaxBytes(): number {
    return this.settings.get().mediaMaxMb * 1024 * 1024;
  }
}

export class NullWa implements WaController {
  private readonly since = Date.now();
  status(): WaStatus {
    return { state: 'idle', mediaQueue: 0, since: this.since, sync: null };
  }
  async start(): Promise<void> {}
  async restart(): Promise<void> {}
  async logout(): Promise<void> {}
  retryMedia(): boolean {
    return false;
  }
  async stop(): Promise<void> {}
}
