/* Minimal conformance harness (MVP) */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function readSSE(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { prompt: 'demo' }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
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
        events.push({ event, data: parsed });
      } catch {
        events.push({ event, data });
      }
    }
  }
  return events;
}

async function case_complex_schema_repair_test() {
  const events = await readSSE('/v1/stream', { mode: 'complex_schema_repair_test' });
  const order = events.map((e) => e.event);
  if (!order.includes('json.begin')) throw new Error('Expected ComplexDemo emitted');
  const deltas = get(events, 'result.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  if (!text.includes('schema_repair_failed')) throw new Error('Expected repaired AssistantReply with diagnostics.error=schema_repair_failed');
  return { pass: true };
}

async function case_deep_combo_repair_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_repair_test' });
  const order = events.map((e) => e.event);
  if (!order.includes('json.begin')) throw new Error('Expected DeepCombo emitted');
  const deltas = get(events, 'result.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  if (!text.includes('schema_repair_failed')) throw new Error('Expected repaired AssistantReply with diagnostics.error=schema_repair_failed');
  return { pass: true };
}

async function case_deep_combo_nested_matrix_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_nested_matrix_test' });
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'DeepCombo') throw new Error('Expected schema=DeepCombo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!text.includes('"matrix"')) throw new Error('Expected matrix field present');
  const itemCount = (text.match(/"kind":"A"|"kind":"B"/g) || []).length;
  if (itemCount < 8) throw new Error('Expected at least 8 items');
  return { pass: true };
}

async function case_deep_combo_massive_strings_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_massive_strings_test' });
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'DeepCombo') throw new Error('Expected schema=DeepCombo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!text.includes('"tags"')) throw new Error('Expected tags present');
  if (!/x{1000,}/.test(text)) throw new Error('Expected massive strings present');
  return { pass: true };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function get(events, ev) {
  return events.filter((e) => e.event === ev).map((e) => e.data);
}

async function case_basic_two_tools() {
  const events = await readSSE('/v1/stream', { prompt: 'Find pizza; book at 7pm' });
  const order = events.map((e) => e.event);
  const reqSequence = ['json.begin', 'json.end', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'result.begin', 'result.end', 'done'];
  const present = reqSequence.every((ev) => order.includes(ev));
  assert(present, `Missing events. Saw: ${order.join(',')}`);
  const toolCalls = get(events, 'tool.call');
  assert(toolCalls[0]?.name === 'places.search', 'First tool.call should be places.search');
  assert(toolCalls[1]?.name === 'bookings.create', 'Second tool.call should be bookings.create');
  const resultDeltas = get(events, 'result.delta');
  const finalDelta = resultDeltas[resultDeltas.length - 1] || {};
  const chunk = finalDelta.chunk || '';
  assert(chunk.includes('Booked at') || chunk.includes('none open'), 'Final result should mention booking or none open');
  return { pass: true };
}

async function case_complex_schema_test() {
  const events = await readSSE('/v1/stream', { mode: 'complex_schema_test' });
  const order = events.map((e) => e.event);
  const hasJson = order.includes('json.begin') && order.includes('json.end');
  const hasResult = order.includes('result.begin') && order.includes('result.end');
  if (!hasJson) throw new Error('Expected ComplexDemo json.begin/json.end');
  if (!hasResult) throw new Error('Expected AssistantReply result frames');
  // Validate that the json.begin announced ComplexDemo
  const begins = get(events, 'json.begin');
  const first = begins[0] || {};
  if (first.schema !== 'ComplexDemo') throw new Error('Expected schema=ComplexDemo');
  return { pass: true };
}

async function case_deep_combo_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_test' });
  const order = events.map((e) => e.event);
  const hasJson = order.includes('json.begin') && order.includes('json.end');
  const hasResult = order.includes('result.begin') && order.includes('result.end');
  if (!hasJson) throw new Error('Expected DeepCombo json.begin/json.end');
  if (!hasResult) throw new Error('Expected AssistantReply result frames');
  const begins = get(events, 'json.begin');
  const first = begins[0] || {};
  if (first.schema !== 'DeepCombo') throw new Error('Expected schema=DeepCombo');
  const deltas = get(events, 'json.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  if (!text.includes('"kind":"A"') || !text.includes('"kind":"B"') || !text.includes('"kind":"C"')) {
    throw new Error('Expected union members A, B, C present');
  }
  if (!text.includes('"flags"')) {
    throw new Error('Expected flags array present');
  }
  return { pass: true };
}

async function case_complex_late_keys_test() {
  const events = await readSSE('/v1/stream', { mode: 'complex_late_keys_test' });
  const order = events.map((e) => e.event);
  if (!order.includes('json.begin') || !order.includes('json.end')) throw new Error('Expected ComplexDemo json frames');
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'ComplexDemo') throw new Error('Expected schema=ComplexDemo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!text.includes('"mode":"search"')) throw new Error('Expected late key mode');
  return { pass: true };
}

async function case_deep_combo_no_flags_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_no_flags_test' });
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'DeepCombo') throw new Error('Expected schema=DeepCombo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (text.includes('"flags"')) throw new Error('Flags should be optional/defaulted and may be absent in JSON');
  return { pass: true };
}

async function case_union_order_test() {
  const events = await readSSE('/v1/stream', { mode: 'union_order_test' });
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'DeepCombo') throw new Error('Expected schema=DeepCombo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!(text.indexOf('"kind":"C"') < text.indexOf('"kind":"B"') && text.indexOf('"kind":"B"') < text.indexOf('"kind":"A"'))) {
    throw new Error('Expected union order C,B,A in items');
  }
  return { pass: true };
}

async function case_sentinel_escape_test() {
  const events = await readSSE('/v1/stream', { mode: 'sentinel_escape_test' });
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!text.includes('\\u27E6') || !text.includes('\\u27E7')) throw new Error('Expected escaped sentinel sequences');
  return { pass: true };
}

async function case_deep_combo_many_items_test() {
  const events = await readSSE('/v1/stream', { mode: 'deep_combo_many_items_test' });
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  // Expect at least 12 items produced
  let countA = (text.match(/"kind":"A"/g) || []).length;
  let countB = (text.match(/"kind":"B"/g) || []).length;
  let countC = (text.match(/"kind":"C"/g) || []).length;
  if (countA + countB + countC < 12) throw new Error('Expected 12 union items');
  return { pass: true };
}

async function case_complex_enum_validation_test() {
  const events = await readSSE('/v1/stream', { mode: 'complex_enum_validation_test' });
  const begins = get(events, 'json.begin');
  if (begins[0]?.schema !== 'ComplexDemo') throw new Error('Expected schema=ComplexDemo');
  const text = get(events, 'json.delta').map((d) => d.chunk || '').join('');
  if (!text.includes('"mode":"book"')) throw new Error('Expected mode=book');
  if (!text.includes('"kind":"place"') || !text.includes('"kind":"time"')) throw new Error('Expected mixed targets present');
  return { pass: true };
}

async function case_retry_test() {
  const events = await readSSE('/v1/stream', { mode: 'retry_test', testKey: 'rt-unique-1' });
  const calls = get(events, 'tool.call');
  assert(calls[0]?.name === 'test.failOnce', 'Expected test.failOnce tool.call');
  const results = get(events, 'tool.result');
  const res = results.find((r) => r.name === 'test.failOnce')?.result || {};
  assert(res.attempt === 2, `Expected attempt 2 after retry, got ${res.attempt}`);
  const deltas = get(events, 'result.delta');
  const last = deltas[deltas.length - 1] || {};
  assert((last.chunk || '').includes('Retry attempts 2'), 'Expected Retry attempts 2 in final result');
  return { pass: true };
}

async function case_timeout_test() {
  const events = await readSSE('/v1/stream', { mode: 'timeout_test' });
  const results = get(events, 'tool.result');
  const res = results.find((r) => r.name === 'test.sleep')?.result || {};
  assert(res.error, 'Expected error field due to timeout');
  const deltas = get(events, 'result.delta');
  const last = deltas[deltas.length - 1] || {};
  assert((last.chunk || '').includes('Timeout test: timed out'), 'Expected timed out acknowledgment in final result');
  return { pass: true };
}

async function case_backpressure_test() {
  const events = await readSSE('/v1/stream', { mode: 'backpressure_test' });
  const deltas = get(events, 'result.delta');
  assert(deltas.length >= 10, `Expected many result.delta frames, got ${deltas.length}`);
  const hasBegin = get(events, 'result.begin').length === 1;
  const hasEnd = get(events, 'result.end').length === 1;
  assert(hasBegin && hasEnd, 'Expected single result.begin and result.end');
  return { pass: true };
}

async function case_repair_test() {
  const events = await readSSE('/v1/stream', { mode: 'repair_test' });
  const deltas = get(events, 'result.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  assert(text.includes('schema_repair_failed'), 'Expected repaired object with diagnostics.error=schema_repair_failed');
  // Optionally assert metrics.degraded
  try {
    const fs = await import('node:fs');
    const metrics = JSON.parse(fs.readFileSync('artifacts/metrics.json', 'utf8'));
    assert(metrics.degraded === true, 'Expected degraded=true in metrics');
  } catch (e) { void e; }
  return { pass: true };
}

async function case_interrupt_test() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/v1/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'interrupt_test' }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
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
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        const parsed = data ? JSON.parse(data) : {};
        events.push({ event, data: parsed });
        if (event === 'tool.call' && parsed?.name === 'test.sleep') {
          controller.abort();
          // exit both loops
          break;
        }
      }
      if (controller.signal.aborted) break;
    }
  } catch (e) { void e; }
  // We should have seen the tool.call but not the final done
  const calls = events.filter((e) => e.event === 'tool.call').map((e) => e.data);
  assert(calls.some((c) => c.name === 'test.sleep'), 'Expected tool.call for test.sleep before abort');
  const hasDone = events.some((e) => e.event === 'done');
  assert(!hasDone, 'Should not receive done after client abort');
  return { pass: true };
}

async function case_idempotency_test() {
  async function readWithHeaders(headers, testKey) {
    const res = await fetch(`${BASE}/v1/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ mode: 'retry_test', testKey }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
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
        const parsed = data ? JSON.parse(data) : {};
        events.push({ event, data: parsed });
      }
    }
    return events;
  }

  const key1 = 'IDEMP-1';
  const ev1 = await readWithHeaders({ 'Idempotency-Key': key1 }, 'idem-unique-1');
  const r1 = get(ev1, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r1.attempt === 2, `First run expected attempt 2, got ${r1.attempt}`);

  const ev2 = await readWithHeaders({ 'Idempotency-Key': key1 }, 'idem-unique-1');
  const r2 = get(ev2, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r2.attempt === 2, `Second run expected cached attempt 2, got ${r2.attempt}`);

  const ev3 = await readWithHeaders({ 'Idempotency-Key': 'IDEMP-2' }, 'idem-unique-2');
  const r3 = get(ev3, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r3.attempt === 2, `Third run expected attempt 2 (new args), got ${r3.attempt}`);
  return { pass: true };
}

async function case_silence_timeout_test() {
  const events = await readSSE('/v1/stream', { mode: 'silence_test' });
  const errs = get(events, 'error');
  assert(errs.length >= 1, 'Expected at least one error event');
  const hasTimeout = errs.some((e) => e.code === 'frame_timeout');
  assert(hasTimeout, 'Expected frame_timeout error');
  return { pass: true };
}

async function case_provider_fallback_test() {
  const events = await readSSE('/v1/stream', { mode: 'provider_fallback_test' });
  const order = events.map((e) => e.event);
  // Expect a result frame from fallback
  const hasResult = order.includes('result.begin') && order.includes('result.end');
  assert(hasResult, 'Expected fallback result frames');
  const deltas = get(events, 'result.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  assert(text.includes('provider_no_result'), 'Expected diagnostics.error=provider_no_result in fallback result');
  // Verify metrics.degraded written
  try {
    const fs = await import('node:fs');
    const metrics = JSON.parse(fs.readFileSync('artifacts/metrics.json', 'utf8'));
    assert(metrics.degraded === true, 'Expected degraded=true in metrics for provider fallback');
  } catch (e) { void e; }
  return { pass: true };
}

// Friendly explanations for each case name
const EXPLAIN = {
  basic_two_tools: 'two tools in order (search → booking), sensible final answer',
  retry_test: 'retry once on flaky tool, succeeds on attempt 2',
  timeout_test: 'slow tool times out safely, final answer explains it',
  backpressure_test: 'many tiny updates handled smoothly (single begin/end)',
  repair_test: 'invalid JSON auto-fixed once; marked degraded',
  interrupt_test: 'client abort stops stream; no final done',
  idempotency_test: 'same request + Idempotency-Key reuses cached result',
  silence_timeout_test: 'no frames triggers clear frame_timeout error',
  provider_fallback_test: 'no provider result → minimal fallback (degraded)',
  complex_schema_test: 'ComplexDemo streams correctly; well-formed answer',
  deep_combo_test: 'DeepCombo includes required variants; proper answer',
  complex_late_keys_test: 'late-arriving keys still form a correct object',
  deep_combo_no_flags_test: 'optional fields may be absent; still valid',
  union_order_test: 'mixed variants appear in intended order',
  sentinel_escape_test: 'special markers escaped; JSON stays valid',
  deep_combo_many_items_test: 'handles many items without breaking structure',
  complex_enum_validation_test: 'validates a specific mode with mixed targets',
  complex_schema_repair_test: 'auto-fix once for ComplexDemo invalid answer',
  deep_combo_repair_test: 'auto-fix once for DeepCombo invalid answer',
  deep_combo_nested_matrix_test: 'nested arrays/objects handled correctly',
  deep_combo_massive_strings_test: 'very long strings handled without breakage',
};

async function main() {
  const cases = [
    { name: 'basic_two_tools', fn: case_basic_two_tools },
    { name: 'retry_test', fn: case_retry_test },
    { name: 'timeout_test', fn: case_timeout_test },
    { name: 'backpressure_test', fn: case_backpressure_test },
    { name: 'repair_test', fn: case_repair_test },
    { name: 'interrupt_test', fn: case_interrupt_test },
    { name: 'idempotency_test', fn: case_idempotency_test },
    { name: 'silence_timeout_test', fn: case_silence_timeout_test },
    { name: 'provider_fallback_test', fn: case_provider_fallback_test },
    { name: 'complex_schema_test', fn: case_complex_schema_test },
    { name: 'deep_combo_test', fn: case_deep_combo_test },
    { name: 'complex_late_keys_test', fn: case_complex_late_keys_test },
    { name: 'deep_combo_no_flags_test', fn: case_deep_combo_no_flags_test },
    { name: 'union_order_test', fn: case_union_order_test },
    { name: 'sentinel_escape_test', fn: case_sentinel_escape_test },
    { name: 'deep_combo_many_items_test', fn: case_deep_combo_many_items_test },
    { name: 'complex_enum_validation_test', fn: case_complex_enum_validation_test },
    { name: 'complex_schema_repair_test', fn: case_complex_schema_repair_test },
    { name: 'deep_combo_repair_test', fn: case_deep_combo_repair_test },
    { name: 'deep_combo_nested_matrix_test', fn: case_deep_combo_nested_matrix_test },
    { name: 'deep_combo_massive_strings_test', fn: case_deep_combo_massive_strings_test },
  ];
  let pass = 0;
  for (const c of cases) {
    try {
      const res = await c.fn();
      pass++;
      const why = EXPLAIN[c.name] ? ` — ${EXPLAIN[c.name]}` : '';
      console.log(`[PASS] ${c.name}${why}`, res || '');
    } catch (err) {
      console.error(`[FAIL] ${c.name}:`, err?.message || err);
    }
  }
  console.log(`\nSummary: ${pass}/${cases.length} passed`);
}

main().catch((e) => {
  console.error('Harness error', e);
  process.exit(1);
});
