import { CONFIG } from './config.js';

export type ProviderParams = {
  system: string;
  user: string;
  model: string;
  temperature: number;
  seed?: number;
  max_tokens?: number;
};

// Streams text deltas from the provider. Calls onDelta for each textual delta.
// If onDelta returns false, streaming stops early.
export async function streamFromProvider(
  params: ProviderParams,
  onDelta: (delta: string) => Promise<boolean> | boolean,
): Promise<void> {
  if (!CONFIG.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');
  const url = `${CONFIG.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`;

  const body: any = {
    model: params.model,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    stream: true,
    messages: [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ],
  };
  if (typeof params.seed === 'number') {
    // Some OpenAI-compatible providers support seed; safe to include
    body.seed = params.seed;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`Provider HTTP ${res.status}: ${t}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n').filter(Boolean);
        let data = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        if (data.trim() === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const delta: string = json?.choices?.[0]?.delta?.content || '';
          if (delta) {
            const cont = await onDelta(delta);
            if (cont === false) return;
          }
        } catch {
          // ignore bad provider event
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
