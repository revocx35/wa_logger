import puppeteer, { type Browser } from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { ChromiumLink } from '../../server/src/wa/chromium.ts';
import { instanceToken } from '../../server/src/supervisor/tokens.ts';

/**
 * Connects to one user's Chromium inside the chromium container the way a tenant worker does: through the manager,
 * with that instance's bearer token (the manager starts the browser on demand).
 *
 *   MANAGER=http://127.0.0.1:19223 CONTROL_SECRET=… INSTANCE=1
 */
export async function connectManagedChromium(opts: { protocolTimeout?: number } = {}): Promise<Browser> {
  const url = process.env.MANAGER ?? 'http://127.0.0.1:19223';
  const secret = process.env.CONTROL_SECRET ?? 'testtest123';
  const id = Number(process.env.INSTANCE ?? 1);
  const link = new ChromiumLink(url, id, instanceToken(secret, id));
  if (!(await link.ensure())) throw new Error(`the chromium manager at ${url} did not start instance ${id}`);
  return puppeteer.connect({ ...(await link.connectOptions()), defaultViewport: null, ...(opts.protocolTimeout ? { protocolTimeout: opts.protocolTimeout } : {}) });
}
