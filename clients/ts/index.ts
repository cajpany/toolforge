export type OnToolCall = (t: { id: string; name: string; args: unknown }) => Promise<unknown>;
export type OnJSON = (j: { id: string; delta?: string; end?: boolean }) => void;
export type OnResult = (r: { id: string; delta?: string; end?: boolean }) => void;
export type OnError = (e: { code: string; message: string }) => void;
export type OnDone = () => void;
export type OnPing = () => void;

export type StartStreamOptions = {
  url?: string;
  body?: unknown;
  signal?: AbortSignal;
  onToolCall?: OnToolCall;
  onJSON?: OnJSON;
  onResult?: OnResult;
  onError?: OnError;
  onDone?: OnDone;
  onPing?: OnPing;
};

export function startStream(opts: StartStreamOptions = {}) {
  const url = opts.url ?? 'http://localhost:3000/v1/stream';
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  let closed = false;

  (async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? { prompt: 'demo' }),
      signal,
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n').filter(Boolean);
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (event.startsWith('json.')) opts.onJSON?.(parsed);
          else if (event.startsWith('result.')) opts.onResult?.(parsed);
          else if (event === 'tool.call') await opts.onToolCall?.(parsed);
          else if (event === 'error') opts.onError?.(parsed);
          else if (event === 'done') opts.onDone?.();
          else if (event === 'ping') opts.onPing?.();
        } catch {
          // ignore parse errors in demo
        }
      }
    }
    closed = true;
  })().catch((e) => {
    console.error('Stream error', e);
  });

  return {
    pause() {
      controller.abort();
    },
    resume() {
      // No-op in demo; real impl would support continuation
    },
    isClosed() {
      return closed;
    },
  };
}
