/** An error whose code/message are safe to return to the client. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, 'unauthorized', 'Please log in.'),
  forbidden: (msg = 'Forbidden.') => new AppError(403, 'forbidden', msg),
  notFound: (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`),
  conflict: (msg: string) => new AppError(409, 'conflict', msg),
  validation: (msg: string) => new AppError(400, 'validation', msg),
  invalidCredentials: () => new AppError(401, 'invalid_credentials', 'Invalid username or password.'),
  rateLimited: (retryAfter: number) =>
    new AppError(429, 'rate_limited', 'Too many attempts. Please wait and try again.', Math.max(1, Math.ceil(retryAfter))),
  busy: () => new AppError(503, 'busy', 'Server is busy, please retry in a moment.', 2),
  unavailable: (msg: string) => new AppError(503, 'unavailable', msg),
};
