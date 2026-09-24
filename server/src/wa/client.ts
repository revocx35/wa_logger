import wwebjs from 'whatsapp-web.js';
import type { Page } from 'puppeteer';
import type { WaState, WaStatus } from '../../../shared/api.js';
import type { AppContext, WaController } from '../context.js';
import { refreshAvatars } from './avatars.js';
import { cdpReachable, cleanupTabs, focusWaTab, resolveBrowserUrl } from './browser.js';
import { Ingest, type WaApi } from './ingest.js';
import { jid, phoneOf, type RawMsg } from './mapper.js';
import { MediaQueue } from './media.js';
import { chatInfo, contactInfo, fetchMessages, listChats, profilePicUrl } from './pageapi.js';
import { INITIAL_SYNC_KEY, Sync, type SyncApi } from './sync.js';

const { Client, NoAuth } = wwebjs;
type ClientT = InstanceType<typeof Client>;

/**
 * whatsapp-web.js calls destroy() itself on some disconnects, and destroy() closes the browser.
 * Our browser is a separate container we merely connect to, so destroy must only disconnect.
 */
class ConnectedClient extends Client {
  override async destroy(): Promise<void> {
    try {
      await this.pupBrowser?.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function rawOf(m: unknown): RawMsg {
  const o = m as { _data?: RawMsg; rawData?: RawMsg };
  return o?._data ?? o?.rawData ?? (m as RawMsg);
}

const AVATAR_INTERVAL_MS = 30 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export class WaService implements WaController {
  private client: ClientT | null = null;
  private state: WaState = 'idle';
  private detail: string | undefined;
  private since = Date.now();
  private me: WaStatus['me'];
  private syncInfo: WaStatus['sync'] = null;
  private connecting = false;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private avatarTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogFailures = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;

  readonly media: MediaQueue;
  readonly ingest: Ingest;
  readonly sync: Sync;

  constructor(private readonly ctx: AppContext) {
    this.media = new MediaQueue(ctx, () => this.page());
    // Chat/contact/history reads go straight to WhatsApp Web's models (see pageapi.ts): the
    // whatsapp-web.js chat helpers throw on current WhatsApp Web builds.
    const livePage = () => {
      const p = this.client?.pupPage;
      return p && !p.isClosed() ? p : null;
    };
    const api: WaApi = {
      getChat: async (chatId) => {
        const page = livePage();
        return page ? chatInfo(page, chatId) : null;
      },
      getContact: async (id) => {
        const page = livePage();
        return page ? contactInfo(page, id) : null;
      },
    };
    this.ingest = new Ingest(ctx, api, this.media);
    const syncApi: SyncApi = {
      listChats: async () => {
        const page = livePage();
        return page ? listChats(page) : [];
      },
      fetchMessages: async (chatId, limit) => {
        const page = livePage();
        return page ? fetchMessages(page, chatId, limit) : [];
      },
    };
    this.sync = new Sync(ctx, this.ingest, syncApi, (p) => {
      this.syncInfo = p;
      ctx.events.emit({ type: 'sync_progress', sync: p });
    });
  }

  /* --------------------------------------------------------- status */

  status(): WaStatus {
    const s: WaStatus = {
      state: this.state,
      mediaQueue: this.media.size(),
      since: this.since,
      sync: this.syncInfo,
    };
    if (this.detail) s.detail = this.detail;
    if (this.me) s.me = this.me;
    return s;
  }

  private setState(state: WaState, detail?: string): void {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
    this.ctx.log.info({ state, detail }, 'whatsapp state');
    this.ctx.events.emit({ type: 'wa_state', status: this.status() });
  }

  private page(): Page | null {
    const p = this.client?.pupPage;
    return p && !p.isClosed() && (this.state === 'ready' || this.state === 'syncing') ? p : null;
  }

  /* ------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    if (!this.ctx.config.waEnabled || !this.ctx.repo.hasOwner()) return;
    if (this.client || this.connecting) return;
    this.stopped = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    const gen = ++this.generation;
    this.setState('starting', 'Connecting to Chromium…');
    try {
      const browserURL = await resolveBrowserUrl(this.ctx.config.chromiumHost, this.ctx.config.cdpPort);
      if (!(await cdpReachable(browserURL))) throw new Error('Chromium is not reachable yet');
      await cleanupTabs(browserURL);
      const client = new ConnectedClient({
        puppeteer: { browserURL, defaultViewport: null, protocolTimeout: 300_000 } as never,
        authStrategy: new NoAuth(),
        webVersionCache: { type: 'none' },
        takeoverOnConflict: true,
        takeoverTimeoutMs: 5_000,
        authTimeoutMs: 120_000,
        qrMaxRetries: 0,
        userAgent: false as never, // keep Chromium's real user agent
        deviceName: 'wa_logger',
        browserName: 'Chrome',
      });
      this.client = client;
      this.attach(client, gen);
      this.setState('starting', 'Loading WhatsApp Web…');
      await client.initialize();
      if (gen !== this.generation) return;
      client.pupBrowser?.on('disconnected', () => this.onBrowserLost(gen));
      // A crashed or closed WhatsApp tab would otherwise stop all events silently.
      client.pupPage?.on('error', () => this.onPageLost(gen, 'WhatsApp tab crashed'));
      client.pupPage?.on('close', () => this.onPageLost(gen, 'WhatsApp tab was closed'));
      if (client.pupBrowser && client.pupPage) await focusWaTab(client.pupBrowser, client.pupPage);
      this.startWatchdog(gen);
      this.attempt = 0;
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.log.warn({ err: msg }, 'whatsapp connect failed');
      await this.teardown();
      this.scheduleReconnect(msg.includes('not reachable') ? 'Chromium is not reachable' : 'Failed to load WhatsApp Web');
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = Math.min(5_000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt++;
    this.setState('error', `${reason}. Retrying in ${Math.round(delay / 1000)}s`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private onBrowserLost(gen: number): void {
    if (gen !== this.generation || this.stopped) return;
    this.ctx.log.warn('connection to Chromium lost');
    void this.teardown().then(() => this.scheduleReconnect('Lost connection to Chromium'));
  }

  private onPageLost(gen: number, reason: string): void {
    if (gen !== this.generation || this.stopped) return;
    this.ctx.log.warn({ reason }, 'WhatsApp page lost');
    this.ctx.repo.audit('wa_page_lost', null, reason);
    void this.teardown().then(() => {
      this.attempt = 0;
      this.scheduleReconnect(reason);
    });
  }

  /** Periodically proves the WhatsApp page still executes JavaScript; reconnects when it hangs. */
  private startWatchdog(gen: number): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogFailures = 0;
    this.watchdogTimer = setInterval(() => {
      const page = this.client?.pupPage;
      if (!page || gen !== this.generation || this.stopped) return;
      const probe = page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        return typeof w.require === 'function' && typeof w.WWebJS !== 'undefined' ? 'ok' : 'loading';
      });
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), WATCHDOG_TIMEOUT_MS).unref());
      void Promise.race([probe, timeout])
        .catch(() => 'error' as const)
        .then((r) => {
          if (gen !== this.generation) return;
          const healthy = r === 'ok' || (r === 'loading' && this.state !== 'ready' && this.state !== 'syncing');
          this.watchdogFailures = healthy ? 0 : this.watchdogFailures + 1;
          if (this.watchdogFailures >= 2) this.onPageLost(gen, `WhatsApp page unresponsive (${r})`);
        });
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  private async teardown(): Promise<void> {
    this.generation++;
    this.media.pause();
    for (const t of [this.reconcileTimer, this.avatarTimer, this.watchdogTimer]) if (t) clearInterval(t);
    this.reconcileTimer = null;
    this.avatarTimer = null;
    this.watchdogTimer = null;
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      try {
        await c.pupBrowser?.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async restart(): Promise<void> {
    if (!this.ctx.config.waEnabled) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.teardown();
    this.attempt = 0;
    this.stopped = false;
    void this.connect();
  }

  async logout(): Promise<void> {
    const page = this.client?.pupPage;
    if (!page) return;
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).require('WAWebSocketModel').Socket.logout();
    });
    this.me = undefined;
    this.setState('disconnected', 'Logged out');
  }

  retryMedia(messageId: string): boolean {
    const row = this.ctx.repo.getMessage(messageId);
    if (!row || row.is_view_once || row.deleted_at && !row.media_id && row.media_status === 'unavailable') {
      return false;
    }
    if (!['failed', 'too_large', 'skipped', 'unavailable'].includes(row.media_status)) return false;
    this.ctx.repo.updateMessage(messageId, { media_status: 'pending', media_attempts: 0, updated_at: Date.now() });
    this.media.enqueue(messageId, 'live');
    this.ctx.events.emit({ type: 'message_update', chatId: row.chat_id, messageId, reason: 'media' });
    return true;
  }

  onDataWiped(): void {
    this.ingest.resetCaches();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.media.stop();
    await this.teardown();
  }

  /* --------------------------------------------------------- events */

  /** Serializes ingest work so events are applied in the order WhatsApp emitted them. */
  private enqueue(label: string, fn: () => unknown): void {
    this.chain = this.chain
      .then(fn)
      .catch((err) => this.ctx.log.error({ err: err instanceof Error ? err.message : String(err), label }, 'ingest error'));
  }

  private attach(client: ClientT, gen: number): void {
    const live = () => gen === this.generation;
    client.on('qr', () => live() && this.setState('qr', 'Scan the QR code with WhatsApp on your phone'));
    client.on('loading_screen', (percent: unknown) => {
      if (live() && this.state !== 'ready' && this.state !== 'syncing') this.setState('authenticating', `Loading chats ${String(percent)}%`);
    });
    client.on('authenticated', () => live() && this.setState('authenticating', 'Linked, loading WhatsApp…'));
    client.on('auth_failure', () => live() && this.setState('disconnected', 'Authentication failed — relink from the WA Web page'));
    client.on('ready', () => live() && void this.onReady(gen));
    client.on('disconnected', (reason: unknown) => {
      if (!live()) return;
      this.media.pause();
      const r = String(reason);
      this.ctx.repo.audit('wa_disconnected', null, r.slice(0, 64));
      this.setState('disconnected', r === 'LOGOUT' ? 'Device was unlinked — scan the QR code again' : `Disconnected (${r})`);
    });

    client.on('message_create', (m: unknown) => this.enqueue('message_create', () => this.ingest.message(rawOf(m), 'live')));
    client.on('message_ciphertext', (m: unknown) => this.enqueue('message_ciphertext', () => this.ingest.message(rawOf(m), 'live')));
    client.on('message_edit', (m: unknown, newBody: unknown, prevBody: unknown) =>
      this.enqueue('message_edit', () => this.ingest.edit(rawOf(m), newBody, prevBody)),
    );
    client.on('message_revoke_everyone', (after: unknown, before: unknown) =>
      this.enqueue('message_revoke_everyone', () => this.ingest.revoke(rawOf(after), before ? rawOf(before) : null)),
    );
    client.on('message_revoke_me', (m: unknown) => this.enqueue('message_revoke_me', () => this.ingest.revokeMe(rawOf(m))));
    client.on('message_reaction', (r: unknown) =>
      this.enqueue('message_reaction', () => this.ingest.reaction(r as Parameters<Ingest['reaction']>[0])),
    );
    client.on('message_ack', (m: unknown, ack: unknown) => this.enqueue('message_ack', () => this.ingest.ack(rawOf(m), ack)));
    for (const ev of ['group_join', 'group_leave', 'group_update', 'group_admin_changed', 'group_membership_request']) {
      client.on(ev, (n: unknown) => this.enqueue(ev, () => this.ingest.groupNotification(n as Parameters<Ingest['groupNotification']>[0])));
    }
    client.on('chat_removed', (chat: { id?: unknown } | undefined) => {
      const id = jid(chat?.id);
      if (id) this.enqueue('chat_removed', () => this.ingest.chatRemoved(id));
    });
    client.on('chat_archived', (chat: { id?: unknown } | undefined, curr: unknown) => {
      const id = jid(chat?.id);
      if (id) this.enqueue('chat_archived', () => this.ingest.chatArchived(id, !!curr));
    });
  }

  private async onReady(gen: number): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation) return;
    try {
      const wid = jid(client.info?.wid);
      if (wid) {
        this.me = { id: wid, name: client.info?.pushname || null, phone: phoneOf(wid) };
        this.ctx.repo.setState('wa_me', wid);
        await this.ingest.ensureContact(wid, client.info?.pushname ?? null, true);
      }
      if (client.pupBrowser && client.pupPage) await focusWaTab(client.pupBrowser, client.pupPage);
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'post-ready setup failed');
    }
    this.ctx.repo.audit('wa_ready', null);
    const firstSync = !this.ctx.repo.getState(INITIAL_SYNC_KEY);
    this.setState(firstSync ? 'syncing' : 'ready', firstSync ? 'Importing chat history…' : undefined);
    this.media.resume();
    this.media.restorePending();

    this.reconcileTimer = setInterval(() => {
      if (gen === this.generation && this.state === 'ready') void this.sync.reconcile().catch(() => undefined);
    }, this.ctx.config.reconcileMs);
    this.reconcileTimer.unref();
    this.avatarTimer = setInterval(() => void this.avatars(gen), AVATAR_INTERVAL_MS);
    this.avatarTimer.unref();

    try {
      if (firstSync) await this.sync.initial();
      else await this.sync.reconcile();
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'sync failed');
    }
    if (gen !== this.generation) return;
    if (this.state === 'syncing' || this.state === 'ready') this.setState('ready');
    void this.avatars(gen);
  }

  private async avatars(gen: number): Promise<void> {
    const client = this.client;
    const page = this.page();
    if (!client || !page || gen !== this.generation) return;
    try {
      await refreshAvatars(this.ctx, page, (chatId) => profilePicUrl(page, chatId));
    } catch (err) {
      this.ctx.log.debug({ err: (err as Error).message }, 'avatar refresh failed');
    }
  }
}
