import type { SendMediaKind, SendResult, WaStatus } from '../../shared/api.js';
import type { Config } from './config.js';
import { Errors } from './errors.js';
import { DataWriter } from './crypto/keyring.js';
import type { Repo } from './db/repo.js';
import { Throttle } from './auth/throttle.js';
import type { EventBus } from './events.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';

/** Sending as the linked account (throws AppError: unavailable when WhatsApp is not connected). */
export interface WaSender {
  sendText(chatId: string, text: string, quotedId: string | null): Promise<SendResult>;
  sendMedia(
    chatId: string,
    file: { data: Buffer; mime: string; filename: string | null },
    kind: SendMediaKind,
    caption: string | null,
    quotedId: string | null,
  ): Promise<SendResult>;
  /** An empty emoji removes the reaction. */
  react(messageId: string, emoji: string): Promise<void>;
  /** Delete for everyone. */
  revoke(messageId: string): Promise<void>;
  edit(messageId: string, text: string): Promise<void>;
  markRead(chatId: string): Promise<void>;
  /** Opens (logs) the chat with a phone number; null when the number is not on WhatsApp. */
  openChat(phone: string): Promise<string | null>;
}

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
  /** Called after all logged data was wiped (drop in-memory caches). */
  onDataWiped(): void;
  stop(): Promise<void>;
  readonly sender: WaSender;
}

export class AppContext {
  private writerInstance: DataWriter | null = null;
  wa: WaController;
  /** Every registered route (filled by an onRoute hook) — used by the auth coverage test. */
  readonly routeTable: { method: string; url: string; public: boolean }[] = [];
  /** Brute-force throttle shared by every credential check. */
  readonly throttle: Throttle;

  constructor(
    readonly config: Config,
    readonly log: Logger,
    readonly repo: Repo,
    readonly events: EventBus,
    readonly settings: SettingsStore,
    wa?: WaController,
  ) {
    this.wa = wa ?? new NullWa();
    this.throttle = new Throttle(repo);
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

const notConnected = async (): Promise<never> => {
  throw Errors.unavailable('WhatsApp is not connected.');
};

export class NullWa implements WaController {
  private readonly since = Date.now();
  readonly sender: WaSender = {
    sendText: notConnected,
    sendMedia: notConnected,
    react: notConnected,
    revoke: notConnected,
    edit: notConnected,
    markRead: notConnected,
    openChat: notConnected,
  };
  status(): WaStatus {
    return { state: 'idle', mediaQueue: 0, since: this.since, sync: null };
  }
  async start(): Promise<void> {}
  async restart(): Promise<void> {}
  async logout(): Promise<void> {}
  retryMedia(): boolean {
    return false;
  }
  onDataWiped(): void {}
  async stop(): Promise<void> {}
}
