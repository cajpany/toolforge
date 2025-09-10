import Fastify from 'fastify';
import { sseHeaders, EventQueue } from './sse.js';
import { CONFIG } from './config.js';
import { FrameStream, type FrameEvent } from './parser.js';
import { ToolsRegistry } from './tools.js';
import { ArtifactsWriter } from './artifacts.js';
import { Validator } from './validator.js';
import { IdempotencyCache } from './idempotency.js';

const app = Fastify({ logger: true });

app.post('/v1/stream', async (request, reply) => {
  const body = (await request.body) as any;

  reply.headers(sseHeaders());
  reply.raw.writeHead(200);
  const queue = new EventQueue(reply, 128);
  const hb = setInterval(() => {
    void queue.send('ping', {});
  }, 15000);
  request.raw.on('close', () => clearInterval(hb));

  const artifacts = new ArtifactsWriter('artifacts');
  artifacts.writePrompt({ request: body, model: CONFIG.MODEL_ID, seed: CONFIG.SEED, temperature: CONFIG.TEMPERATURE });

  const start = Date.now();
  let toolLatencyMs: number | undefined;

  const validator = new Validator();

  const emit = (e: FrameEvent) => {
    switch (e.type) {
      case 'json.begin':
        validator.onJsonBegin(e.id, e.schema);
        void queue.send(e.type, { id: e.id, schema: e.schema });
        artifacts.appendFrame(e.type, e);
        break;
      case 'json.delta':
        validator.onJsonDelta(e.id, e.chunk);
        void queue.send(e.type, { id: e.id, chunk: e.chunk });
        artifacts.appendFrame(e.type, e);
        break;
      case 'json.end':
        validator.onJsonEnd(e.id);
        void queue.send(e.type, { id: e.id, length: e.length });
        artifacts.appendFrame(e.type, e);
        break;
      case 'result.begin':
        validator.onResultBegin(e.id, e.schema);
        void queue.send(e.type, { id: e.id, schema: e.schema });
        artifacts.appendFrame(e.type, e);
        break;
      case 'result.delta':
        validator.onResultDelta(e.id, e.chunk);
        void queue.send(e.type, { id: e.id, chunk: e.chunk });
        artifacts.appendFrame(e.type, e);
        break;
      case 'result.end': {
        validator.onResultEnd(e.id);
        void queue.send(e.type, { id: e.id, length: e.length });
        artifacts.appendFrame(e.type, e);
        break;
      }
      case 'tool.call': {
        void queue.send('tool.call', { id: e.id, name: e.name, args: e.args });
        artifacts.appendFrame('tool.call', { id: e.id, name: e.name, args: e.args });
        break;
      }
      case 'tool.result': {
        void queue.send('tool.result', { id: e.id, name: e.name, result: e.result });
        artifacts.appendFrame('tool.result', { id: e.id, name: e.name, result: e.result });
        break;
      }
      case 'text.delta': {
        // Optional: forward echo; omit for now to keep demo clean
        break;
      }
    }
  };

  const parser = new FrameStream(emit);

  // Model emulator with mid-stream tool call
  const mode = (body && (body as any).mode) as string | undefined;

  const emitTokens = async () => {
    // 1) Action object (not strictly needed for tool, but demonstrates json.* frames)
    parser.ingest('⟦BEGIN_OBJECT id=O1 schema=Action⟧');
    await delay(10);
    parser.ingest('{"type":"search","query":"pizza","radius_km":3}');
    await delay(10);
    parser.ingest('⟦END_OBJECT id=O1⟧');

    if (mode === 'retry_test') {
      // Induce a single failure then retry via execTool
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=test.failOnce⟧');
      const args = { key: 'k1' };
      parser.ingest(JSON.stringify(args));
      parser.ingest('⟦END_TOOL_CALL id=T1⟧');
      let result: any;
      try {
        result = await execTool('test.failOnce', args, request.headers['idempotency-key'] as string | undefined);
      } catch (err) {
        result = { error: String(err) };
      }
      emit({ type: 'tool.result', id: 'T1', name: 'test.failOnce', result });
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: `Retry attempts ${(result?.attempt) ?? 0}`, citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'timeout_test') {
      // Sleep longer than timeout to trigger timeout handling
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=test.sleep⟧');
      const args = { ms: CONFIG.TOOL_TIMEOUT_MS + 1000 };
      parser.ingest(JSON.stringify(args));
      parser.ingest('⟦END_TOOL_CALL id=T1⟧');
      let result: any;
      try {
        result = await execTool('test.sleep', args, request.headers['idempotency-key'] as string | undefined);
      } catch (err) {
        result = { error: String(err) };
      }
      emit({ type: 'tool.result', id: 'T1', name: 'test.sleep', result });
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: `Timeout test: ${result?.error ? 'timed out' : 'ok'}`, citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'backpressure_test') {
      // Emit many small result deltas to exercise SSE queue backpressure
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      const prefix = '{"answer":"';
      const suffix = '","citations":[]}';
      parser.ingest(prefix);
      for (let i = 0; i < 200; i++) {
        parser.ingest('x');
        await delay(1);
      }
      parser.ingest(suffix);
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else {
      // Default happy path: places.search then bookings.create
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=places.search⟧');
      parser.ingest(JSON.stringify({ query: 'pizza', radius_km: 3 }));
      parser.ingest('⟦END_TOOL_CALL id=T1⟧');

      // Handle tool execution synchronously after tool.call is emitted
      const tStart = Date.now();
      const args = { query: 'pizza', radius_km: 3 };
      let result: any = [];
      try {
        result = await execTool('places.search', args, request.headers['idempotency-key'] as string | undefined);
      } catch (err) {
        result = { error: String(err) };
      }
      toolLatencyMs = Date.now() - tStart;
      emit({ type: 'tool.result', id: 'T1', name: 'places.search', result });

      // Second tool call: bookings.create (choose first open place if any)
      await delay(10);
      const open = Array.isArray(result) ? (result as any[]).find((r: any) => r.open_now) : null;
      if (open) {
        parser.ingest('⟦BEGIN_TOOL_CALL id=T2 name=bookings.create⟧');
        const bookingArgs = { place_id: open.id, time: '19:00', party_size: 2 };
        parser.ingest(JSON.stringify(bookingArgs));
        parser.ingest('⟦END_TOOL_CALL id=T2⟧');
        try {
          const bookingRes = await execTool('bookings.create', bookingArgs, request.headers['idempotency-key'] as string | undefined);
          emit({ type: 'tool.result', id: 'T2', name: 'bookings.create', result: bookingRes });
          await delay(10);
          parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
          parser.ingest(
            JSON.stringify({
              answer: `Found ${(result as any[]).length ?? 0} places. Booked at ${open.name} for 7pm. Confirmation: ${bookingRes.confirmation_id}.`,
              citations: [],
            }),
          );
          parser.ingest('⟦END_RESULT id=R1⟧');
        } catch (err) {
          // Booking failed: still return found places
          await delay(10);
          parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
          parser.ingest(
            JSON.stringify({
              answer: `Found ${(result as any[]).length ?? 0} places. Booking failed: ${String(err)}`,
              citations: [],
            }),
          );
          parser.ingest('⟦END_RESULT id=R1⟧');
        }
      } else {
        // No open place, just return found places
        await delay(10);
        parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
        parser.ingest(JSON.stringify({ answer: `Found ${(result as any[]).length ?? 0} places (none open).`, citations: [] }));
        parser.ingest('⟦END_RESULT id=R1⟧');
      }
    }

    // Done
    void queue.send('done', {});
    artifacts.appendFrame('done', {});
    const okJson = validator.notes.filter((n) => n.kind === 'json' && n.ok).length;
    const badJson = validator.notes.filter((n) => n.kind === 'json' && !n.ok).length;
    const okResult = validator.notes.filter((n) => n.kind === 'result' && n.ok).length;
    const badResult = validator.notes.filter((n) => n.kind === 'result' && !n.ok).length;

    artifacts.writeMetrics({
      totalMs: Date.now() - start,
      toolLatencyMs,
      model: CONFIG.MODEL_ID,
      validation: { okJson, badJson, okResult, badResult },
    });
    await queue.close();
  };

  emitTokens().catch((err) => {
    app.log.error({ err }, 'stream error');
    void queue.send('error', { code: 'internal_error', message: String(err) });
    void queue.close();
  });
});

app.get('/health', async () => ({ ok: true, model: CONFIG.MODEL_ID }));

app.listen({ port: 3000, host: '0.0.0.0' }).then(() => {
  app.log.info('ToolForge server running at http://localhost:3000');
});

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

const idemCache = new IdempotencyCache();
async function execTool(name: keyof typeof ToolsRegistry | string, args: any, idempotencyKey?: string) {
  const cached = idemCache.get(idempotencyKey, String(name), args);
  if (cached !== undefined) return cached;
  const fn = ToolsRegistry[String(name)];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  const timeoutMs = CONFIG.TOOL_TIMEOUT_MS;
  const retries = CONFIG.TOOL_RETRIES;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fn(args, idempotencyKey), timeoutMs, `tool_timeout:${name}`);
      idemCache.set(idempotencyKey, String(name), args, res);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await delay(Math.min(100 * (attempt + 1), 500));
        continue;
      }
      throw err;
    }
  }
  // Unreachable, but for TS
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  throw lastErr as any;
}

function withTimeout<T>(p: Promise<T>, ms: number, tag = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(tag)), ms);
    p.then((v) => {
      clearTimeout(to);
      resolve(v);
    }, (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}
