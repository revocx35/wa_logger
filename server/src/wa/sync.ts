import type { WaStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import type { Ingest } from './ingest.js';
import type { RawMsg } from './mapper.js';

export interface ChatLite {
  id: string;
  name: string | null;
  timestamp: number | null; // epoch ms
  archived: boolean;
  pinned: boolean;
  muted: boolean;
}

export interface SyncApi {
  listChats(): Promise<ChatLite[]>;
  fetchMessages(chatId: string, limit: number): Promise<RawMsg[]>;
}

export const INITIAL_SYNC_KEY = 'initial_sync_done';

const RECONCILE_TOP_CHATS = 20;
const RECONCILE_LIMIT = 40;

/**
 * History import (once, after the first successful link) and periodic reconcile, which re-reads
 * recent messages to catch anything missed while disconnected — including deletions (messages whose
 * type turned into "revoked").
 */
export class Sync {
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly ingest: Ingest,
    private readonly api: SyncApi,
    private readonly onProgress: (p: WaStatus['sync']) => void,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  async initial(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const chats = (await this.api.listChats()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const limit = this.ctx.settings.get().historyPerChat;
      let done = 0;
      this.onProgress({ phase: 'history', chatsDone: 0, chatsTotal: chats.length });
      for (const chat of chats) {
        if (chat.id === 'status@broadcast' && !this.ctx.settings.get().logStatus) {
          done++;
          continue;
        }
        this.ingest.upsertChatInfo(chat.id, chat);
        if (limit > 0) {
          try {
            const raws = await this.api.fetchMessages(chat.id, limit);
            for (const raw of raws) await this.ingest.message(raw, 'history');
          } catch (err) {
            this.ctx.log.warn({ err: (err as Error).message }, 'history fetch failed for a chat');
          }
        }
        done++;
        this.onProgress({ phase: 'history', chatsDone: done, chatsTotal: chats.length });
      }
      this.ctx.repo.setState(INITIAL_SYNC_KEY, String(Date.now()));
    } finally {
      this.running = false;
      this.onProgress(null);
    }
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const chats = (await this.api.listChats()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const logStatus = this.ctx.settings.get().logStatus;
      const targets: ChatLite[] = [];
      chats.forEach((chat, i) => {
        if (chat.id === 'status@broadcast' && !logStatus) return;
        const stored = this.ctx.repo.getChat(chat.id);
        if (!stored || stored.removed_at) this.ingest.upsertChatInfo(chat.id, chat);
        const moved = !stored || (chat.timestamp ?? 0) > (stored.last_ts ?? 0);
        if (moved || i < RECONCILE_TOP_CHATS) targets.push(chat);
      });
      let done = 0;
      this.onProgress({ phase: 'reconcile', chatsDone: 0, chatsTotal: targets.length });
      for (const chat of targets) {
        try {
          const raws = await this.api.fetchMessages(chat.id, RECONCILE_LIMIT);
          for (const raw of raws) await this.ingest.message(raw, 'live');
        } catch (err) {
          this.ctx.log.warn({ err: (err as Error).message }, 'reconcile fetch failed for a chat');
        }
        done++;
        this.onProgress({ phase: 'reconcile', chatsDone: done, chatsTotal: targets.length });
      }
    } finally {
      this.running = false;
      this.onProgress(null);
    }
  }
}
