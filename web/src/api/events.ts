import { useEffect, useRef } from 'react';
import type { ServerEvent } from '../../../shared/api';

type Listener = (ev: ServerEvent) => void;

const EVENT_TYPES: ServerEvent['type'][] = ['wa_state', 'message', 'message_update', 'chat_update', 'sync_progress', 'session_revoked'];

/**
 * One shared EventSource for the whole app (SSE; the browser reconnects automatically).
 * Components subscribe with useServerEvents().
 */
class EventHub {
  private source: EventSource | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  connected = false;

  start(): void {
    if (this.source) return;
    const es = new EventSource('/api/events');
    this.source = es;
    es.onopen = () => this.setConnected(true);
    es.onerror = () => {
      this.setConnected(false);
      // A closed (not reconnecting) source means the server rejected us (e.g. logged out).
      if (es.readyState === EventSource.CLOSED) {
        this.source = null;
        window.setTimeout(() => this.listeners.size && this.start(), 5000);
      }
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent<string>).data) as ServerEvent;
          for (const l of this.listeners) l(ev);
        } catch {
          /* ignore malformed */
        }
      });
    }
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    this.setConnected(false);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    for (const l of this.statusListeners) l(v);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (connected: boolean) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
}

export const eventHub = new EventHub();

export function useServerEvents(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => eventHub.subscribe((ev) => ref.current(ev)), []);
}
