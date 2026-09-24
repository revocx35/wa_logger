import dns from 'node:dns/promises';
import puppeteer, { type Browser, type Page } from 'puppeteer';

/**
 * Chromium runs in its own container. Chrome refuses CDP HTTP requests whose Host header is not an
 * IP address or "localhost", so the hostname is resolved to an IP first.
 */
export async function resolveBrowserUrl(host: string, port: number): Promise<string> {
  const { address } = await dns.lookup(host, { family: 4 });
  return `http://${address}:${port}`;
}

export async function cdpReachable(browserURL: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

const isWaUrl = (u: string) => /^https:\/\/web\.whatsapp\.com\//.test(u);

/**
 * Closes leftover WhatsApp tabs from a previous app run (two WA tabs would fight over the session)
 * while keeping at least one tab open so Chromium does not exit.
 */
export async function cleanupTabs(browserURL: string): Promise<void> {
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  try {
    const pages = await browser.pages();
    const wa = pages.filter((p) => isWaUrl(p.url()));
    if (wa.length === pages.length) await browser.newPage();
    for (const p of wa) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  } finally {
    await browser.disconnect();
  }
}

/** After whatsapp-web.js opened its tab: close every other tab and show the WA tab on the VNC screen. */
export async function focusWaTab(browser: Browser, waPage: Page): Promise<void> {
  const pages = await browser.pages();
  for (const p of pages) {
    if (p !== waPage && !isWaUrl(p.url())) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  }
  await waPage.bringToFront().catch(() => undefined);
}

/**
 * Fetches a URL from inside the WhatsApp page (so the app container itself never needs internet
 * access). Falls back to CDP Network.loadNetworkResource when CORS blocks the in-page fetch.
 */
export async function fetchViaBrowser(page: Page, url: string, maxBytes: number): Promise<{ data: Buffer; mime: string | null } | null> {
  if (!/^https:\/\/[a-z0-9.-]+\.(whatsapp\.net|whatsapp\.com|fbcdn\.net)\//i.test(url)) return null;
  const inPage = await page
    .evaluate(
      async (u: string, max: number) => {
        try {
          const r = await fetch(u, { credentials: 'omit' });
          if (!r.ok) return null;
          const blob = await r.blob();
          if (blob.size > max) return null;
          const dataUrl: string = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
          });
          return { b64: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: blob.type || null };
        } catch {
          return null;
        }
      },
      url,
      maxBytes,
    )
    .catch(() => null);
  if (inPage) return { data: Buffer.from(inPage.b64, 'base64'), mime: inPage.mime };

  const cdp = await page.createCDPSession();
  try {
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const frameId = tree.frameTree.frame.id;
    const res = (await cdp.send('Network.loadNetworkResource', {
      frameId,
      url,
      options: { disableCache: false, includeCredentials: false },
    })) as { resource: { success: boolean; httpStatusCode?: number; stream?: string; headers?: Record<string, string> } };
    if (!res.resource.success || !res.resource.stream || (res.resource.httpStatusCode ?? 0) >= 400) return null;
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await cdp.send('IO.read', { handle: res.resource.stream, size: 1 << 20 })) as {
        data: string;
        base64Encoded?: boolean;
        eof: boolean;
      };
      const b = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'binary');
      total += b.length;
      if (total > maxBytes) {
        await cdp.send('IO.close', { handle: res.resource.stream }).catch(() => undefined);
        return null;
      }
      parts.push(b);
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: res.resource.stream }).catch(() => undefined);
    const ct = res.resource.headers?.['content-type'] ?? res.resource.headers?.['Content-Type'] ?? null;
    return { data: Buffer.concat(parts), mime: ct };
  } catch {
    return null;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
