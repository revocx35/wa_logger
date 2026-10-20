/** The supervisor's control protocol: one JSON object per line over a unix socket (front → supervisor and back). */

export type ControlOp = 'spawn' | 'stop' | 'remove' | 'reset-browser' | 'status';

export interface ControlRequest {
  /** Echoed in the response. */
  rid: number;
  op: ControlOp;
  /** Tenant id (1…9999). Not used by `status`. */
  tenant?: number;
}

export interface WorkerHandle {
  /** Unix socket the worker listens on. */
  socketPath: string;
  /** Sent as X-WAL-Internal on every request to the worker. */
  internalToken: string;
}

export type ControlResponse =
  | ({ rid: number; ok: true } & Partial<WorkerHandle> & { workers?: Record<string, { running: boolean; restarts: number }> })
  | { rid: number; ok: false; error: string };

export const MIN_TENANT = 1;
export const MAX_TENANT = 9999;

export function validTenant(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= MIN_TENANT && id <= MAX_TENANT;
}
