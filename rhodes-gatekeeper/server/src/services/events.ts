import { EventEmitter } from 'node:events';

/**
 * In-process event bus for the live dashboard (Server-Sent Events).
 * Events carry IDs only — no personal data. Clients refetch through the authorised API.
 * For multiple server instances, replace with PostgreSQL LISTEN/NOTIFY or Redis pub/sub.
 */
export interface LiveEvent {
  type: 'visit.checked_in' | 'visit.checked_out' | 'visit.updated';
  visitId: string;
  at: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(500);
  }
  publish(e: LiveEvent): void {
    this.emitter.emit('event', e);
  }
  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
