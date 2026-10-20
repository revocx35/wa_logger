import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppState } from '../../../shared/api.js';
import { ctEqual } from '../crypto/primitives.js';
import { AppError, Errors } from '../errors.js';
import type { Gateway } from './gateway.js';

const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '15 minutes' } };

export const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, 'Username must be 3–32 characters: letters, digits, dot, dash, underscore.');

/**
 * The routes that need to know who is asking before there is a session: the gateway picks the user's worker by the
 * username in the body (and refuses silently when that user may not sign in on this port), then relays the answer.
 */
export function registerFrontAuthRoutes(app: FastifyInstance, gw: Gateway): void {
  const route = { config: { front: true, ...AUTH_LIMIT } };

  app.get('/api/state', { config: { front: true } }, async (req) => {
    const port = gw.localPort(req.raw);
    const anonymous = (): AppState => ({
      // Only the default port ever offers the first-time setup; the others always show the login page.
      hasOwner: port === gw.listeners.defaultPort ? gw.repo.hasAdmin() : true,
      authenticated: false,
      onboardingComplete: false,
    });
    const user = gw.identify(req.headers, port, gw.secure(req));
    if (!user) return anonymous();
    const r = await gw.call(user, req, 'GET', '/api/state');
    if (r.status !== 200) return anonymous();
    const state = JSON.parse(r.body.toString('utf8')) as AppState;
    // A worker without an owner yet (the account is waiting to be claimed) is not an unclaimed instance.
    state.hasOwner = true;
    if (state.authenticated) state.role = user.role;
    return state;
  });

  /* ----------------------------------------------------- first-time setup */
  app.post('/api/auth/signup', route, async (req, reply) => {
    gw.requireOrigin(req);
    const body = z.object({ setupToken: z.string().max(512), username: Username, password: z.string().min(1).max(256) }).parse(req.body);
    if (gw.localPort(req.raw) !== gw.listeners.defaultPort) throw Errors.notFound('Route');
    if (gw.repo.userCount() > 0) throw Errors.conflict('This instance is already set up. Please log in.');
    const attempt = gw.throttle.begin(req.ip, { global: false });
    if (!ctEqual(body.setupToken.trim(), gw.config.setupToken)) {
      gw.repo.audit('signup_bad_token', req.ip);
      throw new AppError(401, 'invalid_setup_token', 'Invalid setup token. Find SETUP_TOKEN in your .env file.');
    }
    gw.throttle.success(attempt);
    // The first account is the admin, and it is tenant 1: the id the single-user releases' data already belongs to.
    if (gw.repo.createUser({ id: 1, username: body.username, role: 'admin', port: null }) === null) {
      throw Errors.conflict('This instance is already set up. Please log in.');
    }
    const admin = gw.repo.getUser(1)!;
    try {
      const r = await gw.call(admin, req, 'POST', '/internal/signup', { username: body.username, password: body.password });
      if (r.status !== 200) {
        gw.repo.deleteUser(1);
        return gw.relay(req, reply, admin, r);
      }
      gw.repo.audit('signup', req.ip, { actor: 1 });
      return gw.relay(req, reply, admin, r);
    } catch (err) {
      gw.repo.deleteUser(1);
      throw err;
    }
  });

  /* ------------------------------------- username decides whose worker */
  const byUsername = (path: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    gw.requireOrigin(req);
    const body = z.object({ username: z.string().max(64) }).passthrough().parse(req.body);
    const user = gw.repo.getUserByName(body.username);
    if (!gw.usable(user, gw.localPort(req.raw))) return gw.rejectUnknown(req);
    const r = await gw.call(user, req, 'POST', path, req.body);
    return gw.relay(req, reply, user, r);
  };

  app.post('/api/auth/login', route, byUsername('/api/auth/login'));
  app.post('/api/auth/claim', route, byUsername('/api/auth/claim'));
  app.post('/api/auth/recover', route, byUsername('/api/auth/recover'));
}
