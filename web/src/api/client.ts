import type {
  AppState,
  AuditEntry,
  ChatSummary,
  DeletedFeedPage,
  LoginResponse,
  Message,
  MessageEdit,
  MessagePage,
  RecoverResponse,
  RotateRecoveryKeyResponse,
  SearchResponse,
  SessionInfo,
  Settings,
  SignupResponse,
  TotpSetupResponse,
  VncCredentials,
  WaStatus,
} from '../../../shared/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token ?? '';
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; retryAfter?: number } } | null)?.error;
    if (res.status === 401 && err?.code === 'unauthorized') onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.retryAfter);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<AppState>('GET', '/api/state'),

  signup: (setupToken: string, username: string, password: string) =>
    request<SignupResponse>('POST', '/api/auth/signup', { setupToken, username, password }),
  login: (username: string, password: string, totp?: string) =>
    request<LoginResponse>('POST', '/api/auth/login', { username, password, ...(totp ? { totp } : {}) }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  logoutAll: () => request<{ ok: true }>('POST', '/api/auth/logout-all'),
  recover: (username: string, recoveryKey: string, newPassword: string) =>
    request<RecoverResponse>('POST', '/api/auth/recover', { username, recoveryKey, newPassword }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  sessions: () => request<SessionInfo[]>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: true }>('DELETE', `/api/auth/sessions/${enc(id)}`),
  totpSetup: () => request<TotpSetupResponse>('POST', '/api/auth/totp/setup'),
  totpEnable: (code: string, password: string) => request<{ ok: true }>('POST', '/api/auth/totp/enable', { code, password }),
  totpDisable: (password: string, code: string) => request<{ ok: true }>('POST', '/api/auth/totp/disable', { password, code }),
  rotateRecoveryKey: (password: string, totp?: string) =>
    request<RotateRecoveryKeyResponse>('POST', '/api/auth/recovery-key/rotate', { password, ...(totp ? { totp } : {}) }),

  waStatus: () => request<WaStatus>('GET', '/api/wa/status'),
  waRestart: () => request<{ ok: true }>('POST', '/api/wa/restart'),
  waLogout: () => request<{ ok: true }>('POST', '/api/wa/logout'),
  completeOnboarding: (force = false) => request<{ ok: true }>('POST', '/api/onboarding/complete', force ? { force: true } : {}),
  vncCredentials: () => request<VncCredentials>('GET', '/api/vnc/credentials'),

  chats: () => request<ChatSummary[]>('GET', '/api/chats'),
  messages: (chatId: string, before?: string | null, limit = 60) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ''}`),
  messagesAfter: (chatId: string, after: string, limit = 100) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages/after?after=${enc(after)}&limit=${limit}`),
  messagesAround: (chatId: string, messageId: string, limit = 60) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages/around/${enc(messageId)}?limit=${limit}`),
  message: (messageId: string) => request<Message>('GET', `/api/messages/${enc(messageId)}`),
  edits: (messageId: string) => request<MessageEdit[]>('GET', `/api/messages/${enc(messageId)}/edits`),
  retryMedia: (messageId: string) => request<{ ok: true }>('POST', `/api/messages/${enc(messageId)}/media/retry`),
  deleted: (before?: string | null) => request<DeletedFeedPage>('GET', `/api/deleted?limit=50${before ? `&before=${enc(before)}` : ''}`),
  search: (q: string, chatId?: string) =>
    request<SearchResponse>('GET', `/api/search?q=${enc(q)}${chatId ? `&chatId=${enc(chatId)}` : ''}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),
  audit: (before?: number) => request<AuditEntry[]>('GET', `/api/audit?limit=100${before ? `&before=${before}` : ''}`),
  wipe: (password: string, totp?: string) => request<{ ok: true }>('POST', '/api/data/wipe', { password, ...(totp ? { totp } : {}) }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.retryAfter) return `${e.message} (retry in ${e.retryAfter}s)`;
    return e.message;
  }
  return 'Something went wrong.';
}
