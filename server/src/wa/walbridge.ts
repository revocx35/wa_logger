import type { CDPSession, Page } from 'puppeteer';
import { WAL_PAGE_SOURCE } from './walpage.js';

/** An error raised inside the page; `code` is one of walpage.ts' fail() codes and safe to map to API errors. */
export class PageOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PageOpError';
  }
}

/**
 * Node side of walpage.ts: installs it into the WhatsApp tab (now, and at the start of every later load so
 * WhatsApp Web's self-reloads keep it) and runs its operations.
 */
export class WalPage {
  private cdp: CDPSession | null = null;

  constructor(readonly page: Page) {}

  async attach(): Promise<void> {
    const cdp = await this.page.createCDPSession();
    this.cdp = cdp;
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WAL_PAGE_SOURCE });
    await this.page.evaluate(WAL_PAGE_SOURCE);
  }

  async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.detach().catch(() => undefined);
  }

  /** Runs `window.__wal` operation [op]; throws PageOpError with the page's error code. */
  async call<T>(op: string, args: unknown, timeoutMs = 60_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; code: string; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: 'timeout', error: 'WhatsApp Web did not answer in time.' }), timeoutMs);
    });
    try {
      const r = (await Promise.race([
        this.page.evaluate(
          (o: string, a: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wal = (window as any).__wal;
            return wal ? wal.call(o, a) : { ok: false, code: 'not_ready', error: 'WhatsApp Web is still loading.' };
          },
          op,
          args as never,
        ),
        timeout,
      ])) as { ok: true; value: T } | { ok: false; code: string; error: string };
      if (!r.ok) throw new PageOpError(r.code, r.error);
      return r.value;
    } finally {
      clearTimeout(timer);
    }
  }
}
