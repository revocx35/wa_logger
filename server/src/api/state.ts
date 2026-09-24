import type { FastifyInstance } from 'fastify';
import type { AppState } from '../../../shared/api.js';
import { csrfTokenFor } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';

export const ONBOARDING_KEY = 'onboarding_complete';

export function registerStateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/state', { config: { public: true } }, async (req) => {
    const owner = ctx.repo.getOwner();
    const state: AppState = {
      hasOwner: !!owner,
      authenticated: !!req.session,
      onboardingComplete: ctx.repo.getState(ONBOARDING_KEY) === '1',
    };
    if (req.session && owner) {
      state.csrfToken = csrfTokenFor(req.session.secret);
      state.username = owner.username;
      state.wa = ctx.wa.status();
    }
    return state;
  });

  app.post('/api/onboarding/complete', async (req) => {
    const st = ctx.wa.status();
    const body = (req.body ?? {}) as { force?: unknown };
    if (st.state !== 'ready' && st.state !== 'syncing' && body.force !== true) {
      throw Errors.conflict('WhatsApp is not connected yet. Scan the QR code first.');
    }
    ctx.repo.setState(ONBOARDING_KEY, '1');
    ctx.repo.audit('onboarding_complete', req.ip);
    return { ok: true };
  });
}
