import { z } from 'zod';
import type { Settings } from '../../shared/api.js';
import type { Repo } from './db/repo.js';

export const SettingsSchema = z.object({
  logStatus: z.boolean(),
  downloadHistoryMedia: z.boolean(),
  mediaMaxMb: z.number().int().min(1).max(2000),
  historyPerChat: z.number().int().min(0).max(5000),
});

const KEY = 'settings';

export class SettingsStore {
  private cache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(
    private readonly repo: Repo,
    private readonly defaults: { mediaMaxMb: number; historyPerChat: number },
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const base: Settings = {
      logStatus: true,
      downloadHistoryMedia: true,
      mediaMaxMb: this.defaults.mediaMaxMb,
      historyPerChat: this.defaults.historyPerChat,
    };
    const raw = this.repo.getState(KEY);
    let stored: Partial<Settings> = {};
    if (raw) {
      try {
        stored = SettingsSchema.partial().parse(JSON.parse(raw));
      } catch {
        stored = {};
      }
    }
    this.cache = { ...base, ...stored };
    return this.cache;
  }

  update(patch: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.get(), ...patch });
    this.repo.setState(KEY, JSON.stringify(next));
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
