import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../../shared/api.js';

/**
 * In-process pub/sub for live UI updates (SSE). Events carry only IDs and states — never message
 * content — so the SSE stream needs no decryption.
 */
export class EventBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit(ev: ServerEvent): void {
    this.ee.emit('event', ev);
  }

  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}
