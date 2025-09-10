import type { FastifyReply } from 'fastify';

export function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  } as const;
}

export function writeEvent(reply: FastifyReply, event: string, data: unknown) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${payload}\n\n`);
}

export function startHeartbeat(reply: FastifyReply, intervalMs = 15000) {
  const id = setInterval(() => {
    writeEvent(reply, 'ping', {});
  }, intervalMs);
  return () => clearInterval(id);
}

type QueueItem = { event: string; data: unknown };

export class EventQueue {
  private queue: QueueItem[] = [];
  private flushing = false;
  private closed = false;
  constructor(private reply: FastifyReply, private maxChunks = 128) {}

  async send(event: string, data: unknown) {
    if (this.closed) return;
    this.queue.push({ event, data });
    if (this.queue.length > this.maxChunks) {
      // Backpressure signal: rely on upstream pause in real provider; here we just wait a tick
      await new Promise((r) => setTimeout(r, 1));
    }
    if (!this.flushing) await this.flush();
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const { event, data } = this.queue.shift()!;
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        const ok1 = this.reply.raw.write(`event: ${event}\n`);
        const ok2 = this.reply.raw.write(`data: ${payload}\n\n`);
        if (!ok1 || !ok2) {
          await onceDrain(this.reply);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async close() {
    this.closed = true;
    await this.flush();
    this.reply.raw.end();
  }
}

function onceDrain(reply: FastifyReply) {
  return new Promise<void>((resolve) => {
    reply.raw.once('drain', () => resolve());
  });
}
