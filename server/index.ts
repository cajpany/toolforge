import Fastify from 'fastify';
import { sseHeaders, EventQueue } from './sse.js';
import { CONFIG } from './config.js';
import { FrameStream, type FrameEvent } from './parser.js';
import { ToolsRegistry } from './tools.js';
import { ArtifactsWriter } from './artifacts.js';
import { Validator } from './validator.js';
import { attemptRepair } from './repair.js';
import { IdempotencyCache } from './idempotency.js';
import { streamFromProvider } from './provider.js';

const app = Fastify({ logger: true });

app.post('/v1/stream', async (request, reply) => {
  const body = (await request.body) as any;

  reply.headers(sseHeaders());
  reply.raw.writeHead(200);
  const queue = new EventQueue(reply, 128);
  let isClosed = false;
  const hb = setInterval(() => {
    void queue.send('ping', {});
  }, 15000);
  request.raw.on('close', () => {
    isClosed = true;
    clearInterval(hb);
  });

  const artifacts = new ArtifactsWriter('artifacts');
  artifacts.writePrompt({ request: body, model: CONFIG.MODEL_ID, seed: CONFIG.SEED, temperature: CONFIG.TEMPERATURE });

  const start = Date.now();
  let toolLatencyMs: number | undefined;
  let degraded = false;
  let frameTimer: NodeJS.Timeout | null = null;
  let hadResult = false;
  // Track pending tool when in provider_tools_demo mode
  let providerPendingTool: { id: string; name: string; args: any } | null = null;

  function resetFrameTimer() {
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = setTimeout(async () => {
      if (isClosed) return;
      await queue.send('error', { code: 'frame_timeout', message: 'No frame activity within FRAME_TIMEOUT_MS' });
      await queue.close();
    }, CONFIG.FRAME_TIMEOUT_MS);
  }

  const validator = new Validator();

  const emit = (e: FrameEvent) => {
    switch (e.type) {
      case 'json.begin':
        validator.onJsonBegin(e.id, e.schema);
        void queue.send(e.type, { id: e.id, schema: e.schema });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        break;
      case 'json.delta':
        validator.onJsonDelta(e.id, e.chunk);
        void queue.send(e.type, { id: e.id, chunk: e.chunk });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        break;
      case 'json.end':
        validator.onJsonEnd(e.id);
        void queue.send(e.type, { id: e.id, length: e.length });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        break;
      case 'result.begin':
        validator.onResultBegin(e.id, e.schema);
        void queue.send(e.type, { id: e.id, schema: e.schema });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        hadResult = true;
        break;
      case 'result.delta':
        validator.onResultDelta(e.id, e.chunk);
        void queue.send(e.type, { id: e.id, chunk: e.chunk });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        break;
      case 'result.end': {
        validator.onResultEnd(e.id);
        void queue.send(e.type, { id: e.id, length: e.length });
        artifacts.appendFrame(e.type, e);
        resetFrameTimer();
        break;
      }
      case 'tool.call': {
        void queue.send('tool.call', { id: e.id, name: e.name, args: e.args });
        artifacts.appendFrame('tool.call', { id: e.id, name: e.name, args: e.args });
        resetFrameTimer();
        // Capture pending tool call for provider_tools_demo orchestration
        providerPendingTool = { id: e.id, name: e.name, args: e.args } as any;
        break;
      }
      case 'tool.result': {
        void queue.send('tool.result', { id: e.id, name: e.name, result: e.result });
        artifacts.appendFrame('tool.result', { id: e.id, name: e.name, result: e.result });
        resetFrameTimer();
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
    const skipPrelude = (
      mode === 'provider_demo' ||
      mode === 'provider_tools_demo' ||
      mode === 'provider_fallback_test' ||
      mode === 'complex_schema_test' ||
      mode === 'deep_combo_test' ||
      mode === 'complex_late_keys_test' ||
      mode === 'deep_combo_no_flags_test' ||
      mode === 'union_order_test' ||
      mode === 'sentinel_escape_test' ||
      mode === 'deep_combo_many_items_test' ||
      mode === 'complex_enum_validation_test' ||
      mode === 'complex_schema_repair_test' ||
      mode === 'deep_combo_repair_test' ||
      mode === 'deep_combo_nested_matrix_test' ||
      mode === 'deep_combo_massive_strings_test'
    );
    if (!skipPrelude) {
      // 1) Action object (not strictly needed for tool, but demonstrates json.* frames)
      parser.ingest('⟦BEGIN_OBJECT id=O1 schema=Action⟧');
      await delay(10);
      parser.ingest('{"type":"search","query":"pizza","radius_km":3}');
      await delay(10);
      parser.ingest('⟦END_OBJECT id=O1⟧');

      if (isClosed) return;
      resetFrameTimer();
    }
    if (mode === 'retry_test') {
      // Induce a single failure then retry via execTool
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=test.failOnce⟧');
      const args = { key: (body && (body as any).testKey) || 'k1' };
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
    } else if (mode === 'complex_late_keys_test') {
      // ComplexDemo with late keys appearing across deltas
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OC2 schema=ComplexDemo⟧');
      parser.ingest('{"targets":[');
      await delay(5);
      parser.ingest('{"kind":"time","at":"2025-10-01T12:00:00Z"}],');
      await delay(5);
      parser.ingest('"mode":"search"');
      await delay(5);
      parser.ingest(',"notes":["late-mode"]}');
      parser.ingest('⟦END_OBJECT id=OC2⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'late keys ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'deep_combo_no_flags_test') {
      // DeepCombo without flags field (should default)
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD2 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[{"kind":"A","id":"a2","weight":1}]}');
      parser.ingest('⟦END_OBJECT id=OD2⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'no flags ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'union_order_test') {
      // DeepCombo with union members in reverse order C,B,A
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD3 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[');
      parser.ingest('{"kind":"C","when":"2025-09-10T00:00:00Z","priority":"medium"},');
      parser.ingest('{"kind":"B","name":"b2","tags":[]},');
      parser.ingest('{"kind":"A","id":"a3","weight":0}]}');
      parser.ingest('⟦END_OBJECT id=OD3⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'union order ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'sentinel_escape_test') {
      // DeepCombo with strings containing sentinel escapes
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD4 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[');
      parser.ingest('{"kind":"B","name":"b-escape","tags":["foo \\u27E6 marker \\u27E7","bar"]}],');
      parser.ingest('"flags":["x"]}');
      parser.ingest('⟦END_OBJECT id=OD4⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'sentinels ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'deep_combo_many_items_test') {
      // DeepCombo with many items to produce multiple deltas
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD5 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[');
      for (let i = 0; i < 12; i++) {
        const frag = i % 3 === 0
          ? `{"kind":"A","id":"a${i}","weight":${i}}`
          : i % 3 === 1
          ? `{"kind":"B","name":"b${i}","tags":[]}`
          : `{"kind":"C","when":"2025-09-10T00:00:00Z","priority":"low"}`;
        parser.ingest(frag + (i < 11 ? ',' : '')); await delay(2);
      }
      parser.ingest('],"flags":[]}');
      parser.ingest('⟦END_OBJECT id=OD5⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'many items ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'complex_enum_validation_test') {
      // ComplexDemo with mode=book and mixed targets
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OC3 schema=ComplexDemo⟧');
      parser.ingest('{"mode":"book","targets":[{"kind":"place","id":"p2"},{"kind":"time","at":"2025-10-01T19:00:00Z"}],"notes":[]}');
      parser.ingest('⟦END_OBJECT id=OC3⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'enum ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'complex_schema_repair_test') {
      // Emit ComplexDemo then an invalid AssistantReply to trigger repair
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OC4 schema=ComplexDemo⟧');
      parser.ingest('{"mode":"search","targets":[{"kind":"place","id":"p3"}],"notes":[]}');
      parser.ingest('⟦END_OBJECT id=OC4⟧');
      if (isClosed) return;
      await delay(5);
      // Invalid result (missing answer)
      parser.ingest('⟦BEGIN_RESULT id=R_BAD schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ citations: [] }));
      parser.ingest('⟦END_RESULT id=R_BAD⟧');
      const bad = validator.notes.find((n) => n.kind === 'result' && n.schema === 'AssistantReply' && !n.ok);
      if (bad) {
        degraded = true;
        const repaired = attemptRepair(bad.errors);
        await delay(10);
        parser.ingest('⟦BEGIN_RESULT id=R_FIX schema=AssistantReply⟧');
        parser.ingest(JSON.stringify(repaired));
        parser.ingest('⟦END_RESULT id=R_FIX⟧');
      }
    } else if (mode === 'deep_combo_repair_test') {
      // Emit DeepCombo then an invalid AssistantReply to trigger repair
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD6 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[{"kind":"A","id":"ax","weight":1}],"flags":[]}');
      parser.ingest('⟦END_OBJECT id=OD6⟧');
      if (isClosed) return;
      await delay(5);
      // Invalid result (missing answer)
      parser.ingest('⟦BEGIN_RESULT id=R_BAD schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ citations: [] }));
      parser.ingest('⟦END_RESULT id=R_BAD⟧');
      const bad2 = validator.notes.find((n) => n.kind === 'result' && n.schema === 'AssistantReply' && !n.ok);
      if (bad2) {
        degraded = true;
        const repaired2 = attemptRepair(bad2.errors);
        await delay(10);
        parser.ingest('⟦BEGIN_RESULT id=R_FIX schema=AssistantReply⟧');
        parser.ingest(JSON.stringify(repaired2));
        parser.ingest('⟦END_RESULT id=R_FIX⟧');
      }
    } else if (mode === 'deep_combo_nested_matrix_test') {
      // Emit DeepCombo with extra nested matrix field for deep complexity
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD7 schema=DeepCombo⟧');
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[');
      for (let i = 0; i < 8; i++) {
        const frag = i % 2 === 0
          ? `{"kind":"A","id":"na${i}","weight":${i}}`
          : `{"kind":"B","name":"nb${i}","tags":["t${i}"]}`;
        parser.ingest(frag + (i < 7 ? ',' : ''));
        await delay(2);
      }
      parser.ingest('],"flags":["x","y"],"matrix":[[');
      // nested arrays of small objects (as strings inside to keep schema permissive)
      parser.ingest('{"k":"v"},{"k":"w"}');
      parser.ingest(']]}');
      parser.ingest('⟦END_OBJECT id=OD7⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'nested matrix ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'deep_combo_massive_strings_test') {
      // Emit DeepCombo with very long strings in tags to simulate heavy deltas
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD8 schema=DeepCombo⟧');
      const long = 'x'.repeat(2048);
      parser.ingest('{"meta":{"version":1,"source":"cli"},"items":[');
      parser.ingest(`{"kind":"B","name":"big","tags":["${long}","${long}"]}`);
      parser.ingest('],"flags":[]}');
      parser.ingest('⟦END_OBJECT id=OD8⟧');
      if (isClosed) return;
      await delay(5);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'massive strings ok', citations: [] }));
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
        // Call without retries to ensure single-timeout within FRAME_TIMEOUT_MS
        const fn = ToolsRegistry['test.sleep'];
        result = await withTimeout(fn(args, request.headers['idempotency-key'] as string | undefined), CONFIG.TOOL_TIMEOUT_MS, 'tool_timeout:test.sleep');
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
    } else if (mode === 'repair_test') {
      // Emit an invalid result (missing required 'answer'), then repair
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
      // After validator processes, check for invalid and emit repaired
      const bad = validator.notes.find((n) => n.kind === 'result' && n.schema === 'AssistantReply' && !n.ok);
      if (bad) {
        degraded = true;
        const repaired = attemptRepair(bad.errors);
        await delay(10);
        parser.ingest('⟦BEGIN_RESULT id=R2 schema=AssistantReply⟧');
        parser.ingest(JSON.stringify(repaired));
        parser.ingest('⟦END_RESULT id=R2⟧');
      }
    } else if (mode === 'interrupt_test') {
      // Emit a long-running tool, but client will abort shortly after tool.call
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=test.sleep⟧');
      const args = { ms: 5000 };
      parser.ingest(JSON.stringify(args));
      parser.ingest('⟦END_TOOL_CALL id=T1⟧');
      if (isClosed) return; // client disconnected
      let result: any;
      try {
        result = await execTool('test.sleep', args, request.headers['idempotency-key'] as string | undefined);
      } catch (err) {
        result = { error: String(err) };
      }
      emit({ type: 'tool.result', id: 'T1', name: 'test.sleep', result });
      if (isClosed) return;
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'Interrupt test completed', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'silence_test') {
      // Do nothing further; expect frame timeout to trigger
      await delay(CONFIG.FRAME_TIMEOUT_MS + 200);
    } else if (mode === 'provider_demo') {
      // Stream from provider with deterministic config and forward to parser
      const system = await import('node:fs').then((m) => m.readFileSync('prompts/system.txt', 'utf8'));
      const userMsg = typeof body?.prompt === 'string' ? body.prompt : 'Follow the sentinel framing instructions and produce a short demo.';
      await streamFromProvider({
        system,
        user: userMsg,
        model: CONFIG.MODEL_ID,
        temperature: CONFIG.TEMPERATURE,
        seed: CONFIG.SEED,
        max_tokens: CONFIG.MAX_TOKENS,
      }, async (delta: string) => {
        if (isClosed) return false;
        if (delta) parser.ingest(delta);
        return true;
      });
    } else if (mode === 'provider_tools_demo') {
      // Orchestrate provider stream with mid-stream tools: pause -> execute -> resume
      const system = await import('node:fs').then((m) => m.readFileSync('prompts/system.txt', 'utf8'));
      const baseUser = typeof body?.prompt === 'string' ? body.prompt : 'Follow the sentinel framing instructions and produce a short demo with tools.';
      let messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: system },
        { role: 'user', content: baseUser },
      ];

      // Run multiple rounds until result emitted without further tool calls
      for (let round = 0; round < 5; round++) {
        providerPendingTool = null;
        const controller = new AbortController();
        await streamFromProvider({
          messages,
          model: CONFIG.MODEL_ID,
          temperature: CONFIG.TEMPERATURE,
          seed: CONFIG.SEED,
          max_tokens: CONFIG.MAX_TOKENS,
        }, async (delta: string) => {
          if (isClosed) return false;
          if (delta) parser.ingest(delta);
          // If model emitted a tool.call, abort to handle it
          if (providerPendingTool) return false;
          return true;
        }, controller.signal).catch(() => { /* ignore abort or provider end */ });

        if (isClosed) return;
        if (!providerPendingTool) {
          // No tool requested in this round; assume provider reached END_RESULT path
          break;
        }

        // Execute the pending tool
        const { id, name, args } = providerPendingTool;
        providerPendingTool = null;
        let result: any;
        try {
          result = await execTool(name, args, request.headers['idempotency-key'] as string | undefined);
        } catch (err) {
          result = { error: String(err) };
        }
        emit({ type: 'tool.result', id, name, result });

        // Append tool result to messages for the next round (assistant confirms tool results)
        messages = messages.concat({ role: 'assistant', content: `TOOL_RESULT id=${id} name=${name}\n${JSON.stringify(result)}` });
      }
    } else if (mode === 'provider_fallback_test') {
      // Intentionally do not emit any result or tool frames; fallback will trigger
      await delay(10);
    } else if (mode === 'complex_schema_test') {
      // Emit a ComplexDemo object and a minimal AssistantReply
      await delay(10);
      parser.ingest('⟦BEGIN_OBJECT id=OC1 schema=ComplexDemo⟧');
      parser.ingest(JSON.stringify({ mode: 'search', targets: [{ kind: 'place', id: 'p1' }], notes: ['n1'] }));
      parser.ingest('⟦END_OBJECT id=OC1⟧');
      if (isClosed) return;
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else if (mode === 'deep_combo_test') {
      // Emit DeepCombo with union/enum and late-required keys across deltas
      await delay(5);
      parser.ingest('⟦BEGIN_OBJECT id=OD1 schema=DeepCombo⟧');
      // meta.version first
      parser.ingest('{"meta":{"version":1');
      await delay(5);
      // late key: meta.source arrives later
      parser.ingest(',"source":"cli"},');
      await delay(5);
      // start items array, push different union members across deltas
      parser.ingest('"items":[');
      parser.ingest('{"kind":"A","id":"a1","weight":3},');
      await delay(3);
      parser.ingest('{"kind":"B","name":"b1","tags":["t1","t2"]},');
      await delay(3);
      parser.ingest('{"kind":"C","when":"2025-09-10T00:00:00Z","priority":"high"}]');
      await delay(3);
      // flags optional
      parser.ingest(',"flags":["x","z"]}');
      parser.ingest('⟦END_OBJECT id=OD1⟧');
      if (isClosed) return;
      await delay(10);
      parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
      parser.ingest(JSON.stringify({ answer: 'deep combo ok', citations: [] }));
      parser.ingest('⟦END_RESULT id=R1⟧');
    } else {
      // Default happy path: places.search then bookings.create
      await delay(10);
      parser.ingest('⟦BEGIN_TOOL_CALL id=T1 name=places.search⟧');
      parser.ingest(JSON.stringify({ query: 'pizza', radius_km: 3 }));
      parser.ingest('⟦END_TOOL_CALL id=T1⟧');

      // Handle tool execution synchronously after tool.call is emitted
      if (isClosed) return;
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
      if (isClosed) return;
      const open = Array.isArray(result) ? (result as any[]).find((r: any) => r.open_now) : null;
      if (open) {
        parser.ingest('⟦BEGIN_TOOL_CALL id=T2 name=bookings.create⟧');
        const bookingArgs = { place_id: open.id, time: '19:00', party_size: 2 };
        parser.ingest(JSON.stringify(bookingArgs));
        parser.ingest('⟦END_TOOL_CALL id=T2⟧');
        if (isClosed) return;
        try {
          const bookingRes = await execTool('bookings.create', bookingArgs, request.headers['idempotency-key'] as string | undefined);
          emit({ type: 'tool.result', id: 'T2', name: 'bookings.create', result: bookingRes });
          await delay(10);
          if (isClosed) return;
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
          if (isClosed) return;
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
        if (isClosed) return;
        parser.ingest('⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧');
        parser.ingest(JSON.stringify({ answer: `Found ${(result as any[]).length ?? 0} places (none open).`, citations: [] }));
        parser.ingest('⟦END_RESULT id=R1⟧');
      }
    }

    // If provider modes didn’t produce any result, emit degraded fallback
    if (!hadResult && (mode === 'provider_demo' || mode === 'provider_tools_demo' || mode === 'provider_fallback_test')) {
      degraded = true;
      parser.ingest('⟦BEGIN_RESULT id=R_FALLBACK schema=AssistantReply⟧');
      parser.ingest(
        JSON.stringify({
          answer: '',
          citations: [],
          diagnostics: {
            error: 'provider_no_result',
            model: CONFIG.MODEL_ID,
          },
        }),
      );
      parser.ingest('⟦END_RESULT id=R_FALLBACK⟧');
    }

    // Done
    if (!isClosed) void queue.send('done', {});
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
      degraded,
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
